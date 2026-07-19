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
#   - Automations are seeded "recently run" (not due) so a boot never auto-spawns the agent; the
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
# BUILDEX_NO_SEED_CARD=1: the demo normally seeds a live approval card at boot, but here we want the
# content shots to have an empty ("All caught up") tray and inject the gate card ourselves below.
BUILDEX_DEMO_DIR="$DEMO" BUILDEX_DEMO_PORT="$PORT" BUILDEX_DEMO_GATEWAY_PORT="$GWPORT" BUILDEX_KEYCHAIN=memory \
  BUILDEX_NO_SEED_CARD=1 npx tsx "$REPO/scripts/demo.ts" >/tmp/buildex-shots-daemon.log 2>&1 &
DAEMON_PID=$!
for _ in $(seq 1 30); do curl -sf "$BASE/api/sessions" >/dev/null 2>&1 && break; sleep 1; done
curl -sf "$BASE/api/sessions" >/dev/null 2>&1 || { echo "✗ daemon never came up (see /tmp/buildex-shots-daemon.log)"; exit 1; }

echo "▶ 3/5  Dismissing first-run onboarding ..."
curl -s -X POST "$BASE/api/onboarding/complete" -d '{}' >/dev/null 2>&1 || true

echo "▶ 4/5  Capturing screenshots ..."
mkdir -p "$STAGE"
"$B" viewport 1440x900 >/dev/null 2>&1

# click the first element whose visible label contains "$1" (dynamic-ref safe), then settle
click_by() {
  local ref
  ref="$("$B" snapshot -i -C 2>/dev/null | grep -F "$1" | grep -oE '@[ce][0-9]+' | head -1)" || true
  if [ -n "$ref" ]; then "$B" click "$ref" >/dev/null 2>&1 || true; sleep 1; else echo "   (not found: $1)"; fi
}
shot() { "$B" screenshot "$STAGE/$1" >/dev/null 2>&1 && echo "   ✓ $1"; }

# Clean shots first (no pending badge yet), so only the gate shot shows a Pending card.
"$B" goto "$BASE" >/dev/null 2>&1; sleep 1
click_by "metrics-q3.md";                          shot console-overview.png
click_by "Draft the Q3 investor update";           shot session-transcript.png
click_by "Reconcile Globex invoices for July";     shot needs-attention.png
click_by "Store";                                  shot app-store.png
click_by "Skills";                                 shot skills.png
click_by "Map";                                    shot workspace-map.png
click_by "Files"; click_by '"log.md"';             shot decision-log.png

# Approval gate: inject a real ask-tier card WITHOUT running the agent (background POST blocks on it).
# Use the same outward Gmail-send shape the live demo seeds, so the flagship shot shows a readable
# human approval ("Send email to dana@globex.com …") rather than a raw tool/JSON blob.
curl -s -X POST "$BASE/api/gate" -H 'content-type: application/json' \
  -d '{"name":"mcp:gmail.send","input":{"connector":"gmail","tool":"send","args":{"to":"dana@globex.com","subject":"Re: Finance team expansion - next steps","body":"Hi Dana - on SSO: it isn'"'"'t in v1 yet, so the interim is a shared service account (fine for ~60 days). I'"'"'ve attached the data-access checklist. - You"},"summary":"Send email to dana@globex.com - reply on SSO (interim: a shared service account) with the data-access checklist attached."}}' >/dev/null 2>&1 &
GATE_PID=$!
sleep 1
"$B" goto "$BASE" >/dev/null 2>&1; sleep 1
click_by "Pending";                                shot approval-gate.png

echo "▶ 5/5  Copying into docs/images/ ..."
mkdir -p "$DEST"
cp "$STAGE"/*.png "$DEST/"
echo "✓ Done. $(ls "$STAGE"/*.png | wc -l | tr -d ' ') screenshots refreshed in docs/images/"
