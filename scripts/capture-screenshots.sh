#!/usr/bin/env bash
# Regenerate the BuildEx launch screenshots (docs/images/*.png) from a fresh demo org, end-to-end,
# with one command:  task screenshots
#
# What it does, deterministically and with NO agent/token spend:
#   1. Seeds a throwaway demo company (the rich team-acme org from scripts/demo-setup.ts) into an
#      isolated dir, so it never touches your everyday ~/.buildex-demo.
#   2. Boots the daemon on a dedicated port and waits for it.
#   3. Dismisses the first-run onboarding overlay via the API (so the populated UI shows).
#   4. Drives the served console with the gstack /browse headless browser, capturing each view.
#   5. Copies the PNGs into docs/images/ and tears everything down.
#
# The approval-gate shot is produced by POSTing a synthetic ask-tier tool to /api/gate in the
# background: that creates a real Pending card (and blocks on it) WITHOUT running the agent. The
# card is denied on cleanup.
#
# MAINTAINER TOOL. Requires the gstack /browse binary (a local dev tool, not a repo dependency).
# The console is a plain web app served over HTTP, which is why a headless browser can shoot it at
# full fidelity - no native Electron screen capture needed. If you don't have gstack, this exits
# with a clear message; the demo itself (npm run demo) still works for manual capture.
#
# Tips baked in (learned the hard way):
#   - /browse only writes screenshots under /private/tmp or the repo root, so we stage in
#     /private/tmp and copy into docs/images/ at the end.
#   - The onboarding overlay is gated on GET /api/onboarding and cleared by POST
#     /api/onboarding/complete - far more reliable than clicking through its 4 steps.
#   - Element refs (@e.../@c...) are dynamic; we click by matching visible text in a fresh snapshot
#     each time rather than hardcoding refs.
#   - Loops are seeded "recently run" (not due) so a boot never auto-spawns the agent; the
#     gate card here is injected explicitly instead.
set -eu

PORT="${BUILDEX_SHOTS_PORT:-4319}"
GWPORT="${BUILDEX_SHOTS_GATEWAY_PORT:-4320}"
DEMO="${BUILDEX_SHOTS_DEMO_DIR:-$HOME/.buildex-demo-shots}"
REPO="$(git rev-parse --show-toplevel)"
STAGE="/private/tmp/buildex-shots"
DEST="$REPO/docs/images"
BASE="http://127.0.0.1:$PORT"

# --- resolve the gstack /browse binary (same lookup as the browse skill) ---
B=""
[ -x "$REPO/.claude/skills/gstack/browse/dist/browse" ] && B="$REPO/.claude/skills/gstack/browse/dist/browse"
[ -z "$B" ] && [ -x "$HOME/.claude/skills/gstack/browse/dist/browse" ] && B="$HOME/.claude/skills/gstack/browse/dist/browse"
if [ -z "$B" ]; then
  echo "✗ gstack /browse not found (looked in the repo and ~/.claude/skills/gstack/browse/dist/browse)."
  echo "  This is a maintainer-only tool. Install gstack, or capture manually after 'npm run demo'."
  exit 1
fi

DAEMON_PID=""
GATE_PID=""
cleanup() {
  [ -n "$GATE_PID" ] && kill "$GATE_PID" 2>/dev/null || true
  # deny any pending gate card so nothing is left waiting
  curl -s "$BASE/api/pending" 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{JSON.parse(d).cards.forEach(c=>console.log(c.id))}catch{}})' 2>/dev/null \
    | while read -r id; do curl -s -X POST "$BASE/api/approve" -d "{\"id\":\"$id\",\"verdict\":\"deny\"}" >/dev/null 2>&1 || true; done
  [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null || true
  lsof -ti "tcp:$PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true
  "$B" stop >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "▶ 1/5  Seeding a fresh demo org at $DEMO ..."
BUILDEX_DEMO_DIR="$DEMO" npx tsx "$REPO/scripts/demo-setup.ts" --reset >/dev/null

echo "▶ 2/5  Booting the daemon on :$PORT ..."
lsof -ti "tcp:$PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true
# Seed the real flagship approval card at boot (the demo's default): demo.ts raises it in-process
# through the same ApprovalBroker the connector gateway uses for a gated send, so the Pending tray
# shows a genuine outward-email approval - the exact human gate we want in the gate/hero shots.
BUILDEX_DEMO_DIR="$DEMO" BUILDEX_DEMO_PORT="$PORT" BUILDEX_DEMO_GATEWAY_PORT="$GWPORT" BUILDEX_KEYCHAIN=memory \
  npx tsx "$REPO/scripts/demo.ts" >/tmp/buildex-shots-daemon.log 2>&1 &
DAEMON_PID=$!
for _ in $(seq 1 30); do curl -sf "$BASE/api/sessions" >/dev/null 2>&1 && break; sleep 1; done
curl -sf "$BASE/api/sessions" >/dev/null 2>&1 || { echo "✗ daemon never came up (see /tmp/buildex-shots-daemon.log)"; exit 1; }

echo "▶ 3/5  Dismissing first-run onboarding + settling the workspace ..."
curl -s -X POST "$BASE/api/onboarding/complete" -d '{}' >/dev/null 2>&1 || true
# The seed writes loops.yaml after the initial commit, which the console counts as one unsaved change
# (the "Save your work" card). Hit the product's own "Save now" (POST /api/sync) to commit + push it,
# so the tray shows only the real approval card - no save prompt - in every shot.
curl -s -X POST "$BASE/api/sync" >/dev/null 2>&1 || true
sleep 1

echo "▶ 4/5  Capturing screenshots ..."
mkdir -p "$STAGE"
rm -f "$STAGE"/*.png   # step 5 copies the whole staging dir - never let a stray PNG ride along
"$B" viewport 1440x900 >/dev/null 2>&1

# click the first element whose visible label contains "$1" (dynamic-ref safe), then settle
click_by() {
  local ref
  ref="$("$B" snapshot -i -C 2>/dev/null | grep -F "$1" | grep -oE '@[ce][0-9]+' | head -1)" || true
  if [ -n "$ref" ]; then "$B" click "$ref" >/dev/null 2>&1 || true; sleep 1; else echo "   (not found: $1)"; fi
}
shot() { "$B" screenshot "$STAGE/$1" >/dev/null 2>&1 && echo "   ✓ $1"; }

# The first-run coach-mark tour is gated on the localStorage flag buildex.tour.v1, which a fresh
# browser profile lacks - so it auto-starts and dims every shot. Load once, mark the tour as seen,
# then reload so the populated console renders clean (no overlay), with the real approval card in the
# tray and the workspace already settled (no "Save your work" card).
"$B" goto "$BASE" >/dev/null 2>&1; sleep 1
"$B" storage set buildex.tour.v1 1 >/dev/null 2>&1 || true
"$B" goto "$BASE" >/dev/null 2>&1; sleep 1

# The right panel is now two surfaces: the BRAIN rail (default) and DOCUMENTS. The old Pending and
# Skills panels folded into the Brain rail's Gate / Rules & Skills stages, so those shots are driven
# by clicking the stage headers, not a panel tab.

# --- Documents-panel shots: the brain's real file tree on the right (docs live there, not in the
#     session rail). Folders render collapsed, so expand one before opening a file inside it. ---
click_by "Documents"                                                  # right panel → the brain file tree
click_by "finance"; click_by "metrics-q3.md";      shot console-overview.png   # a brain doc + the file tree
click_by "BuildEx";                                shot workspace-map.png       # the brand opens the living brain map (middle), tree still on the right
click_by "decisions"; click_by "log.md";           shot decision-log.png        # expand decisions/, open the log
click_by "Draft the Q3 investor update";           shot session-transcript.png  # the chat: its answer renders a real table

# --- Rules & Skills (in the Brain rail) + the Store ---
click_by "Brain"                                                      # back to the Brain rail
click_by "Rules & Skills";                         shot skills.png    # the stage that holds the always-on rules + the agent's skills
click_by "Rules & Skills"                                             # collapse it again (the hero wants the rail at rest)
click_by "Store";                                  shot app-store.png # the App Store (a middle tab)

# --- Brain-rail shots. The Gate stage carries the real seeded outward-email card (see step 2) and
#     auto-opens whenever something is waiting, so it needs no click. ---
click_by "Reconcile Globex invoices for July";     shot needs-attention.png  # a session flagged for you
# Hero composite for the website: the whole product in one frame - apps rail (left), an open chat
# whose answer renders a real table (middle), and the live Brain rail with the gate card (right).
click_by "Draft the Q3 investor update";           shot console-hero.png
# The flagship gate on its own: the approval card, front and center.
click_by "Reply to Dana's kickoff email";          shot approval-gate.png

echo "▶ 5/5  Copying into docs/images/ ..."
mkdir -p "$DEST"
cp "$STAGE"/*.png "$DEST/"
echo "✓ Done. $(ls "$STAGE"/*.png | wc -l | tr -d ' ') screenshots refreshed in docs/images/"
