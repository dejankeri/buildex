# How sync, backup, and never-lose-work behave

BuildEx treats **git as the database**. There's no shadow store — your company's brain *is* a set of
git repositories on your machine. That single choice is what makes sync, history, and backup simple
and trustworthy.

## Every change is a commit

When the agent (or you) edits a document, that's a commit. So you get, for free:

- **Full history** on every document — open the **History** on any doc to see each version, who made
  it, and when.
- **One-tap restore** — pick an earlier version and **Restore** it. The restore is itself a new
  commit, so nothing is destroyed; the version you replaced is still in history.
- **Real diffs and review** — because it's git, a teammate can review a change like any pull request.

## Sync only moves commits

Sync pulls and pushes commits between your machines and your teammates on a background interval. It
runs off the main loop with timeouts, so a slow or unreachable remote degrades gracefully to
*offline* — it never freezes the app or your agent.

What sync **cannot** do: read your brain or your model traffic. It moves git objects between repos
*you* control. The cloud is a relay, not a reader.

Some things are deliberately **never synced** — your local sessions, in-flight agent state, and
approval history stay on your machine.

## Never lose your work

The rule is: **an operator's work is never silently discarded.** If content can't be cleanly
committed — a conflict, a half-written file, something unexpected — BuildEx backs it up locally and
flags it for you rather than dropping it. A corrupt file in a list is quarantined and skipped, so one
bad file never bricks the view. You resolve it when you're ready; nothing is lost in the meantime.

## Backup, in practice

Because each brain is a git repo with a remote you control, your backup is your git host — push and
your history is off-machine. Want a local archive? It's a folder of markdown and a `.git`; copy it
like any directory. There's no proprietary format to export from and no database to dump.

## The short version

- Your files, on your machine, in git.
- Every change committed; full history; one-tap restore.
- Sync relays commits and can't read them.
- Unclean work is backed up and flagged, never discarded.
