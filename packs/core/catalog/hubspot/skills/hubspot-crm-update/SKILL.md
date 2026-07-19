---
name: hubspot-crm-update
description: Use when the operator asks you to update the CRM in HubSpot - log a call or email, move a deal stage, create a contact - so the record changes only through a reviewed, approved action.
---

# hubspot-crm-update - propose a CRM change

Turn a request into a precise HubSpot update, proposed for the operator's approval.

## When to use

- The operator says "log that call", "move this deal to negotiation", "add them as a contact".

## Steps

1. Look up the record first (see hubspot-crm-lookup) so you edit the right one, not a duplicate.
2. State exactly what changes: which record, which field/stage, and the new value.
3. Propose the update; it is an outward change, so it surfaces as an approval card - wait.
4. After approval, confirm what changed and link the record.

## Rules

- Prefer updating the canonical record over creating a near-duplicate contact or company.
- Don't fabricate activity notes; log only what actually happened, in the operator's words.
