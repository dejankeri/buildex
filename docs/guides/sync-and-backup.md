# How saving, sync, and never-lose-work behave

Your company's brain is a set of plain files on your machine, versioned forever. Nothing lives in a
hidden database — that single choice is what makes saving, history, and backup simple and
trustworthy.

## Two layers of safety: checkpoints and saves

- **Checkpoints are automatic.** As you and the agent work, every change is checkpointed on your
  machine within moments. Checkpoints are the safety net — a crash, a bad edit, a mistake can always
  be walked back. You never think about them.
- **Saves are deliberate.** When a piece of work is ready — a revised strategy, an updated client
  ledger, a new decision — you **Save**. A save bundles everything since the last save into one
  named version with a short summary of what changed; BuildEx suggests one from the files you
  touched, and you can keep or rewrite it. Saves are what **History** shows, what syncs to your
  team, and what you can restore to.

So History reads like a changelog of the company — "Repriced the Pro tier; updated two client
ledgers" — not a firehose of tiny edits. One version per meaningful moment. Anything you haven't
saved yet appears as a single *Unsaved changes* entry at the top, so nothing is ever invisible.

- **Full history** on every document — open **History** on any doc to see each saved version, who
  made it, and when.
- **One-tap restore** — pick an earlier version and **Restore** it. The restore is an ordinary
  change — checkpointed at once and part of your next save — so nothing is destroyed; the version
  you replaced is still in history.

## Sync only moves saves

Sync shares your saves with your teammates and your other machines in the background. A slow or
unreachable connection degrades gracefully to *offline* — it never freezes the app or your agent,
and your work keeps checkpointing locally. When you're back online, your saves flow.

What sync **cannot** do: read your brain or your AI traffic. It relays your saved versions between
machines *you* control. The cloud is a relay, not a reader.

Some things are deliberately **never synced** — your local sessions, in-flight agent state, and
approval history stay on your machine.

## Never lose your work

The rule is: **an operator's work is never silently discarded.** If two people changed the same
document and the versions can't be combined cleanly, the team's version wins so nobody is blocked —
and your version is kept safe on your machine and flagged for you. A card in the Pending tray shows
you what was kept: view it side by side with the current version, or copy your text back in with one
tap (the copy-back is an ordinary edit — checkpointed at once, part of your next save, and in
History from then on). When you've
decided, tap **Got it** — the card clears, and the kept copy still stays on your machine. Nothing is
lost, ever.

## Backup, in practice

Every save is stored both on your machine and, once synced, off it. Want a local archive? Your brain
is a folder of plain documents — copy it like any folder. There's no proprietary format to export
from and no database to dump; if you ever leave, you take everything with you as-is.

## The short version

- Your files, on your machine, versioned forever.
- Changes checkpoint automatically; you save deliberately; History shows named versions.
- Sync relays your saves and can't read them.
- Conflicting work is kept and shown to you, never discarded.
