---
name: gcal-agenda
description: Use when the operator asks what's on their calendar or when they're free in Google Calendar - today's agenda, a specific day, free/busy - before proposing or creating events.
---

# gcal-agenda - read the calendar

Pull the relevant Google Calendar events or free/busy window before you reason about time.

## When to use

- The operator asks "what's on today?", "am I free Thursday afternoon?", "when's my next call?".
- You are about to create or move an event and need the current agenda first.

## Steps

1. List events or query free/busy for the window with the Google Calendar tools.
2. Read the details - title, attendees, time, timezone - before summarizing.
3. If the window is ambiguous (which day, whose calendar), ask before assuming.
4. Report times in the operator's timezone and link the event so they can verify.

## Rules

- Reading the calendar is safe and runs freely; **creating, moving, or deleting** an event waits for
  the operator's approval - especially anything with other attendees. Never send invites unattended.
