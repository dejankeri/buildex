# Run the e2e tests for a pack

The **e2e test engine** exercises a pack's whole flow the way a real operator would hit it:
install the pack → its MCP connection activates → its skills reach the agent → **the agent does
real work through the provider's tools**. It runs headlessly, provisions its own throwaway
workspace for every run, and leaves only a report behind.

There are two tracks:

- **Deterministic track** (`runDeterministic.ts`) — exact pass/fail checks on the plumbing:
  did the app, skills, and policy install; does the pinned MCP connection actually answer.
- **Proof track** (`runProof.ts`) — the naturalistic layer: generate day-in-the-life scenarios
  from the pack's *discovered* surface (its skills + live tools), drive each with the real agent
  in its own clean room, score each with an independent judge, and emit a findings report.

The engine knows no provider. Any pack becomes testable the same way; the examples below use a
locally-run provider because that is the lane that needs no extra infrastructure.

## What you need

- The repo checked out, dependencies installed (`npm install` at the root).
- A pack in the catalog with an **http `mcp` face** and an **`mcp-bearer` `apiKey` face** (the pin
  rides that api-key path). Most connector packs qualify.
- A provider you can reach, and a key for it. The simplest setup is a provider you run **locally**.

All commands below run from `apps/client`.

## The local lane — a provider you run yourself

This is the lane that works today with zero extra setup. You point the engine at your local
provider's MCP URL and hand it a key; it pins that key directly and skips the mint/destroy
machinery (there is nothing to mint — resetting your local instance *is* the clean slate).

Two rules that trip people up:

- **The key must be generated on the *local* instance.** A production key will not authenticate
  against `localhost`. Issue a fresh key from your local instance, wherever it hands out API keys.
- **`http://` is accepted only for loopback hosts** (`localhost`, `127.0.0.1`, `[::1]`).
  Everywhere else the URL must be `https://`.

The key is read from the environment (never a flag, never a file the run keeps):

```bash
export BUILDEX_LOCAL_MCP_KEY=<your-local-key>
```

### 1. Plumbing check (deterministic)

Start here — it is fast and needs no agent:

```bash
# install + pin only, no agent, no provider call:
npx tsx src/harness/runDeterministic.ts --pack <pack> --no-sandbox --no-agent

# install + pin + drive the real agent once against your local provider:
npx tsx src/harness/runDeterministic.ts --pack <pack> --mcp-url http://localhost:<port>/mcp
```

Exit `0` means the install verified and the drive (if any) did not error. The run writes
`results.json` under `~/.buildex-e2e/runs/<timestamp>-<pack>/`.

### 2. Full proof run

```bash
npx tsx src/harness/runProof.ts --pack <pack> --mcp-url http://localhost:<port>/mcp --cases 3
```

Flags:

- `--cases <1-20>` — how many scenarios to generate (default 5).
- `--baseline <path>` — a prior run's `surface.json`, to report **surface drift** (new/removed
  skills or tools) against it. Optional; a missing or unreadable baseline is never fatal.

Exit `0` only when the install verified, no drive crashed, no case scored **fail**, and every case
was judged.

## What a run leaves behind

A proof run writes to `~/.buildex-e2e/proof-runs/<timestamp>-<pack>-proof/`:

- **`index.html`** (+ `matrix.html`, `findings.html`, `cases/<id>.html`, `styles.css`) — the
  analyst-facing HTML report bundle. Open `index.html` in a browser: an overview with the
  scorecard, a **test plan** page (the surface under test, the scenario matrix, and how the judge
  scores), a **findings** page (the four buckets + strengths), and one **drill-down page per
  scenario** with the prompt, the judge's verdict and cited evidence, and the full transcript. It is
  self-contained (no external assets), so the whole folder is portable — copy it anywhere.
- **`report.md`** — the same findings in Markdown, for the terminal and for diffing.
- **`proof-results.json`** — the same data as structured JSON; every HTML page is built from it.
- **`surface.json`** — the discovered surface (skills + live tools) this run tested against; feed
  it to a later run's `--baseline`.
- **`cases/`, `judge/`, `discovery/`, `generator/`** — the per-step working dirs and transcripts.

Both reports are rendered deterministically — no model runs when they are built, so the same run
data always produces byte-identical files, on any OS.

## Which model runs

The engine never chooses a model. It spawns your own agent CLI, and every spawned role — the
scenario generator, the driven agent, the judge — runs on whatever model that CLI is configured
to use as its default.

A proof run is therefore a statement about the **pack and the model together**: a different model
can generate different scenarios, drive them differently, and band the same transcript
differently. Note the model alongside a run's results, and compare runs (including `--baseline`
drift checks) only against runs made on the same model. The deterministic track's checks, the run
gate, and both rendered reports do not vary with the model.

## Clean slate

Every run provisions its own throwaway BuildEx workspace and deletes it at teardown; your real demo
workspace is never touched. To wipe the *artifacts*, delete the run directory (or the whole
`~/.buildex-e2e/` tree). To reset the *provider's* data on the local lane, reset your local
instance — that is the clean slate the engine relies on.

## Safety — read before pointing this anywhere real

- Both CLIs are **interrupt-safe**: a hard kill (Ctrl+C / SIGTERM) runs teardown before exiting, so
  the throwaway workspace — and the pinned key inside its `.mcp.json` — is deleted, not left behind.
  (A `SIGKILL` or power loss can't run teardown; if that happens, delete the leftover run directory
  under `~/.buildex-e2e/` by hand.)
- Run artifacts **survive the run and can contain whatever the agent read** — real records, names,
  anything in the provider account. They live outside git under `~/.buildex-e2e/`; treat them as
  sensitive and do not share a run directory casually.
- **Do not aim the engine at a live production account.** The driven agent runs with the full
  operator toolset (including `Bash`) and, in this headless test lane, **without the product's
  approval gate** — it can create and change real data. The pack under test is treated as trusted
  code. See the **Trust model** section of [`sandbox-face.md`](../sandbox-face.md) for the full
  contract.

## Testing against a provider you don't run

For a hosted provider whose backend you cannot reset, the safe path is the **`sandbox` face**: the
provider implements `create` / `seed` / `destroy` endpoints that mint a *throwaway, hermetic*
workspace per run, and declares a `sandbox` face in its `pack.json`. The engine then mints, tests,
and destroys that workspace automatically. That contract is specified in
[`sandbox-face.md`](../sandbox-face.md); the engine side is built, but a provider must implement the
endpoints before this lane can run against it.
