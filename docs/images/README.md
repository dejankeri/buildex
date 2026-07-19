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
2. boots the daemon, dismisses the first-run overlay,
3. drives the served console with a headless browser and captures each view,
4. copies the PNGs back here, and tears everything down.

It's deterministic and spends **no** Claude usage — even the approval-gate shot is produced by
injecting a synthetic gate card, not by running the agent.

**Requires** the gstack `/browse` binary (a maintainer dev tool, not a repo dependency). Without it
the script exits with a clear message; you can still capture manually after `npm run demo`.

## The shots

| File | View |
|---|---|
| `console-overview.png` | The whole console — sessions rail, a brain doc, apps, history |
| `session-transcript.png` | A chat with the company brain ("draft the Q3 investor update") |
| `approval-gate.png` | The Pending tray — outward actions waiting for a human tap |
| `app-store.png` | The App Store with installed apps |
| `decision-log.png` | The decision log rendered next to the full file tree |
| `needs-attention.png` | A session flagged for the operator's attention |
| `skills.png` | The Skills panel — verbs the agent can run |
| `workspace-map.png` | The living map of the company brain |

To change *what* the screenshots show (the demo company, its files, sessions, or apps), edit the seed
in [`scripts/demo-setup.ts`](../../scripts/demo-setup.ts) and re-run `task screenshots`.
