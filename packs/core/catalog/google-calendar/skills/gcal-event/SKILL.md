---
name: gcal-event
description: Use when the operator asks you to create or change a Google Calendar event - book a meeting, invite people, move or cancel something - so anything attendee-facing goes out only after review.
---

# gcal-event - create or update a calendar event

Turn a request into a precise Google Calendar event, proposed for the operator's approval.

## When to use

- The operator says "put a meeting on for…", "invite them", "move my 2pm", "cancel Friday's call".

## Steps

1. Check the agenda first (see gcal-agenda) so you avoid a conflict and act on the right event.
2. State the event: title, exact time and timezone, attendees, and whether invites go out.
3. Propose the create/change; it is attendee-facing and outward, so it surfaces as an approval card - wait.
4. After approval, confirm what was set and who was invited, and link the event.

## Rules

- Any event with other attendees is human-gated - never send, move, or cancel invites unattended.
- Don't invent attendees or agendas; use only the people and details the operator gave.
