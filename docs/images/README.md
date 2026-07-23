# Launch screenshots

These are the product screenshots used in the top-level [`README.md`](../../README.md) and available
for the site. They show the demo company (*Acme Labs*) running on BuildEx.

## Regenerating them (one command)

When the product changes and you want fresh screenshots:

```sh
task screenshots
```

That runs [`scripts/capture-screenshots.sh`](../../scripts/capture-screenshots.sh), which:

1. seeds a throwaway demo org (the rich `team-acme` from `scripts/demo-setup.ts`) in an isolated dir,
2. boots the daemon (which seeds the real flagship approval card in-process), dismisses the first-run
   overlay + tour, and taps "Save now" so the tray shows only the approval card,
3. drives the served console with a headless browser and captures each view,
4. copies the PNGs back here, and tears everything down.

It's deterministic and spends **no** Claude usage. The approval card is a genuine one raised through
the same `ApprovalBroker` the connector gateway uses for a gated send — not a mock — so "Show request"
reveals the real outward-email args; the agent itself is never run.

**Requires** the gstack `/browse` binary (a maintainer dev tool, not a repo dependency). Without it
the script exits with a clear message; you can still capture manually after `npm run demo`.

## The shots

| File | View |
|---|---|
| `console-hero.png` | The whole product in one frame — apps rail, a chat answering with a live table, and the live Brain rail with the gate card (the site's hero shot) |
| `console-overview.png` | The whole console — apps & sessions, a brain doc, the Documents tree |
| `session-transcript.png` | A chat with the company brain ("draft the Q3 investor update"), its answer a real table |
| `approval-gate.png` | The Brain rail's Gate stage — an outward email waiting for a human tap, beside the chat that raised it |
| `app-store.png` | The App Store with installed apps |
| `decision-log.png` | The decision log rendered next to the full file tree |
| `needs-attention.png` | A session flagged for the operator's attention |
| `skills.png` | The Brain rail's Rules & Skills stage — the always-on rules plus the skills the agent reaches for |
| `workspace-map.png` | The living brain map — the company loop, next to the file tree |

To change *what* the screenshots show (the demo company, its files, sessions, or apps), edit the seed
in [`scripts/demo-setup.ts`](../../scripts/demo-setup.ts) and re-run `task screenshots`.
