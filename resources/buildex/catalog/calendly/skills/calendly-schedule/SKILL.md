---
name: calendly-schedule
description: Use when the operator asks you to share a booking link or change a booked meeting in Calendly - a single-use link, a cancellation, a reschedule - so anything invitee-facing goes out after review.
---

# calendly-schedule - propose a scheduling action

Turn a request into a precise Calendly action, proposed for the operator's approval.

## When to use

- The operator says "send them a link to book", "cancel that meeting", "reschedule the 3pm".

## Steps

1. Check availability first (see calendly-availability) so you act on the right event type/booking.
2. State the action: which event type the link is for, or which booked event you'd cancel/reschedule.
3. Propose it; it is invitee-facing and outward, so it surfaces as an approval card - wait.
4. After approval, return the link or confirm the change, and note who it affects.

## Rules

- Cancelling or rescheduling touches someone else's calendar - always human-gated, never batched around.
- Don't invent meeting details or reasons; use only what the operator gave you.
