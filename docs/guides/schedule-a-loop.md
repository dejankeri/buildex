# Schedule a loop (work that runs on its own)

A **loop** is a prompt — or one of your verbs — plus a schedule. *Draft the Monday update every
Monday at 9am.* *Sweep the inbox every two hours.* When a loop fires, your agent runs it exactly as
if you had typed it into a chat: same transcript, same gate on anything outward.

Loops run **while BuildEx is open**. Nothing runs on a closed laptop — the cloud syncs, it never
thinks.

## Make one

1. Open the **Loops** panel (right rail, the ↻ icon).
2. Click **+ New loop**.
3. Name it, say what it should do, and pick when:
   - **Every…** — `30m`, `2h`, `1d`. Five minutes is the floor.
   - **At a time** — a clock time plus the days it should run.
4. The line underneath reads the schedule back in plain English. Create.

Each card shows what the loop does, when it next runs, and how the last run went. The status chip
links to that run's transcript. **Run now** fires it immediately whatever the schedule says.

## Reading the run strip

Under each card is a row of small marks — one per run, oldest on the left, up to the last twenty.
Green ran clean, amber stopped for you, red failed, grey means the window was missed. Click any mark
to open that run. **⋯ → Run history** lists the same runs with their times.

The strip is where a *pattern* shows up: a loop that fails every Monday looks nothing like a loop
that failed once. Run stamps are per machine, so this is what happened on *this* computer.

## Being told when a loop needs you

BuildEx can raise a system notification when a loop stops for your approval or fails — the case
where the Loops tab badge is no use, because you are looking at something else. It can also tell you
when a long agent answer has landed in a chat.

Turn them on from the prompt in the Loops panel, or from **your profile → Notifications**, where you
can also switch either kind off. Nothing fires while BuildEx is the window in front of you.

Notifications need BuildEx running: a closed app raises nothing, and a loop that needed you waits
with its badge until you next open it.

## What happens when a window is missed

Your laptop was shut, or the app was closed. On the next launch:

- **Interval loops** (`every: 2h`) fire **once**, not once per missed window. Three days off does not
  produce 36 runs.
- **Time-of-day loops** (`at 09:00`) fire once if the window is less than **four hours** old — you
  open the laptop at 10:30, you get the 9am draft. Past that it is recorded **Missed** and waits for
  tomorrow, because a 9am standup draft written at 8pm is worse than none.

If several loops come due at once, two start immediately and the rest follow on the next tick.

## When a loop needs you

Loops hit the same gate everything else does. If a loop tries something outward — sending an email,
spending money — while nobody is at the machine, it cannot wait indefinitely: the approval card
times out and the action is refused, cleanly.

The card then reads **Needed you** and names what it tried. Tap **Run now**: you are there, so the
approval appears live and you approve it in the moment. The Loops tab carries a badge while any loop
is waiting on you.

## Loops are shared; running them is per machine

`loops.yaml` is committed, so a loop you create reaches everyone in your company — and every machine
that has BuildEx open. If they all fired it you would get two Monday updates and two emails, so
**a loop only runs on a machine that has been switched on for it**:

- A loop you **create here** runs here. No extra step.
- A loop that arrives **from a teammate or your other machine** shows as *not running on this
  machine*. Tap **Run here** to adopt it.
- **Pause here** drops it on this machine only. **Pause for everyone** (in the ⋯ menu) stops it for
  the whole company by editing the shared file.
- **Run now** always works, on any machine, adopted or not — running something by hand is not the
  same as scheduling it.

Adopting a loop restarts its clock, so taking on one that last ran months ago on someone else's
machine waits a full window instead of firing the moment you tap.

## Where loops live

Definitions are plain text in your brain, at `loops.yaml` in your team repo — versioned and
reviewable like everything else:

```yaml
- name: monday-review
  title: Monday update
  prompt: Read last week's activity log and draft the Monday update.
  at: "09:00"
  days: mon
  enabled: true

- name: pipeline-digest
  title: Pipeline digest
  verb: pipeline-digest
  every: 12h
  enabled: true
```

Edit the file directly if you prefer; the panel reads it live. An entry it cannot honour exactly is
skipped rather than guessed at, so a typo can never quietly reschedule your company.

Run stamps — when each loop last ran, how it went, and whether this machine runs it at all — stay on
your machine in `.loops-state.json`, and the run history in `.loops-runs.json`. Neither is committed,
so scheduling churn does not pollute your brain and one machine's choices never override another's.

## Known edges

- **Loops do not run while BuildEx is closed**, and a closed app cannot notify you either.
- **The history keeps the last twenty runs per loop**, per machine. Older runs are forgotten.
- **Each fire spends your agent usage.** A loop `every: 30m` is 48 unattended runs a day, and
  BuildEx does not yet meter or cap that — keep an eye on the intervals you pick.
