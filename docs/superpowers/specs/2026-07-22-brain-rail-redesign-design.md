# Brain Rail redesign — design

**Date:** 2026-07-22
**Status:** approved, implementing
**Surface:** `apps/client/web` (the vanilla-JS operator console)

## Problem

The console shows the company brain twice and scatters its pieces:

- The **Brain** is a *center tab* (`openBrainTab`) — a big animated star/loop (Sensor · Policy ·
  Tools · Gate · Learning) with a drill-in rail glued to its right.
- The **right panel** is a 4-way tab switcher: **Pending**, **Files**, **Skills**, (hidden
  Automations). Skills exist in *two* places — the standalone Skills tab **and** the brain's Policy
  node. Pending and the sync log are separate right panels that duplicate the Gate and Learning
  nodes.
- **Files** is a raw repo tree. It mixes the brain's own backing files (skill markdown, decision
  notes) with genuine documents, and shows the operator git structure they should never have to
  think in.

The operator has no single, persistent map of their company's mind, and "files" leaks plumbing.

## The idea

Split the brain into **two views of one thing**, and collapse the right panel to **two surfaces**:

- **The map** — a compact, live brain navigator that owns the right rail permanently.
- **The poster** — the full-size animated star, surviving as the center "home".
- Right-panel switcher shrinks from 4 tabs to **2 icons: 🧠 Brain · 📄 Documents**.

The brain holds two kinds of things, and the redesign separates them:

- **Brain-objects** — the company's *mind*: sensors, policy/verbs, tools, gate, learnings. The loop.
  These are what the map shows. The operator meets skills/decisions only *as brain-objects*, never as
  files.
- **Documents** — the company's *stuff*: light synced docs + connected external storage (Drive,
  Dropbox). Never skills/decisions. A separate surface.

## Decisions (from brainstorming)

1. **Files fork → separate Documents surface.** Not "files behind an advanced toggle". The brain's
   backing files disappear as *files*; a distinct Documents surface holds genuine documents.
2. **Rail spine → live star + loop sections.** The star stays a small **live** animated loop on top
   (not a static badge); below it, the 5 loop sections. Ownership is a *lens* (a scope toggle), not
   the top-level split — because Sensors/Tools/Gate are company-level and don't split by owner.
3. **Rail ↔ center → expand in rail, item to center.** Clicking a section expands it in place
   (accordion); clicking an item opens it in the center as a reader/editor tab. The rail is the one
   navigator; center reads/edits one thing.
4. **Decisions → folded into Policy·Verbs.** Keep exactly 5 loop nodes; a verb *is* a decision made
   runnable ("what you decided").
5. **Center default → full brain as home.** The full-size animated star survives as the center home
   and as what the rail hub / brand button open.
6. **Documents → two backends, one space.** *In your repo (synced)* = light docs only (allowlist +
   size cap), git-backed, team-synced. *Connected (external)* = Drive/Dropbox, media/heavy files,
   mounted in the same view (seam now, wired later — invariant #10). Per-item provenance badge.
7. **Media guard → auto-route to external, zero data loss.** Light+small → repo. Media/heavy →
   connected drive. No drive connected → held + flagged locally with a "connect a drive" prompt
   (invariant #8: never lose the operator's work; invariant #2: the repo stays light).

## Architecture

The console is vanilla JS: ordered `<script src>` classic modules sharing one global `S`, rendered
imperatively into `#rpanel` (right) and `#tabbody` (center tabs). No framework. The jsdom console
harness (`src/console-harness.ts`) loads the real bundle and asserts DOM output + escaping.

### Right switcher (`index.html`, `boot.js`, `right-rail.js`)

`#rtabs` drops from 4 buttons to **2**: `data-r="brain"` (brain glyph) and `data-r="documents"`
(folder glyph). `switchRight` routes `brain → rBrain`, `documents → rDocs`. Legacy tab names
(`pending`, `files`, `skills`, `automations`, `synclog`) still *resolve* — persisted `S.rightTab`
from an older build, and the sync-dot's `switchRight("synclog")`, must never blank the panel — so
they map onto the new panels: `files → rDocs`, `skills → rBrain`, `pending → rBrain`,
`synclog → rBrain`, `automations → rBrain`. Default panel becomes `brain` (was `pending`).

### The brain rail — `rBrain()` (new file `web/js/brain-rail.js`)

Renders into `#rpanel`, top to bottom:

1. **Mini live star.** Reuses `brainNodes()`, `buildBrainSvg()`, `startBrainFlow()` from `brain.js`
   unchanged. A `compact` flag on the wrapper scales it to ~150px via CSS. The hub (`data-k=""`) and
   any node click open the **full brain** center tab focused on that node (`openBrainTab(key)`), not
   an in-rail focus — the rail's own sections are the drill-in.
2. **Scope toggle** — a 3-segment control **All · Company · Private** (`S.brainScope`, persisted).
   A real filter (see Ownership), not decoration.
3. **5 accordion sections** — Sensors · Policy·Verbs · Tools · Gate · Learning, each a header row
   with its live count and a caret. Open/closed remembered in `S.brainOpen[key]`. An open section
   lists its items inline (scope-filtered), reusing the existing item renderers:
   - **Policy·Verbs** — skill cards; click → `openSkillTab(name)`; a **+ Teach** affordance →
     `openSkillEditor(null)`. (The standalone `rSkills` panel is retired; its helpers stay.)
   - **Gate** — pending cards with Approve/Deny → `resolveCard` then reload.
   - **Learning** — recent commits; file chips → `openDocTab`.
   - **Sensors / Tools** — read-only connector / MCP-tool lists.

`rBrain` fetches the same 6 sources `loadBrain()` already fetches, stashed on `S.brain`, and
re-renders. A 4s refresh (folded into the existing pending poll) keeps counts live.

### Documents — `rDocs()` (evolves `rFiles` in `right-rail.js`)

Header renames **Files → Documents**. The tree renders in **two zones**:

- **In your repo (synced)** — today's Company/Private sections, unchanged, each item badged
  `synced`.
- **Connected (external)** — a section listing connected drives (empty day one) + a
  **"+ Connect a drive"** row. Backed by an `ExternalStore` interface with a stub adapter that
  returns no drives yet (invariant #10 seam). Items badged by provider.

The "Show everything" machinery (core library, agent files) stays behind the ⚙, unchanged.

**Media guard** — a pure classifier `classifyDrop({name, size}) → "repo" | "external" | "held"`:
light allowlist (`md, txt, csv, json, markdown, …`) under a size cap → `repo`; else, if a drive is
connected → `external`; else → `held` (backed up locally + "connect a drive" prompt). Wired into
`uploadIntoFolder`: a `repo` file uploads as today; `external`/`held` divert (external upload is the
stub seam; `held` shows the flag + prompt). The classifier is pure and unit-tested in isolation.

### Center home (`brain.js`, `boot.js`, `tabs.js`)

`openBrainTab(focusKey?)` gains an optional focus argument (defaults `""`). Brand button and rail
hub both call it. The full animated brain remains the center showpiece and the empty-state home.

### Ownership (the honest scope toggle) — `wiring.ts`, `brain/skills.ts`, `daemon.ts`

`listSkills` currently returns `{name, description}`. To make the toggle real, it also returns
`root` — the origin slot (`team | private | core`), computed by exporting and reusing `originOf`
(already used by `readSkill`). `/api/skills` and the `skills()` daemon contract carry `root`.
Policy·Verbs filters on `rootSlot(root)`; Learning filters on each commit's file roots. Company-level
sections (Sensors/Tools/Gate) are unaffected by Company scope and collapse to a one-line
"company-level" note under Private scope — honest, never faked.

## Seams / tests (invariant #1 discipline)

- **`rBrain` / section renderers** — pure over the `S.brain` snapshot; hermetic in the jsdom harness,
  no network. New suite `console-render-brain-rail.test.ts`: the accordion renders a section per
  node; open lists items; the scope toggle filters Policy·Verbs + Learning; company-level sections
  survive Company scope; hostile skill/tool/commit text is **escaped** (the XSS canary the net
  exists to hold).
- **`classifyDrop`** — pure classifier, unit-tested in isolation (allowlist, size cap,
  drive-connected vs not).
- **`ExternalStore`** — interface + stub adapter day one; repo-synced is the only live backend.
- **Ownership** — `brain/skills.test.ts` gains a case that `listSkills` reports `root`.
- **Migration safety** — `console-render-rail.test.ts` updated: switcher has `brain` + `documents`
  (not files/skills/pending); a stale `switchRight("files")`/`("skills")`/`("pending")` lands on a
  real panel, never a blank.

## Out of scope

- Real Drive/Dropbox wiring (interface + stub only).
- Per-file "synced" state beyond the zone badge.
- Automations UI (already hidden; stays retired under the brain rail, feature intact).
