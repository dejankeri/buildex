---
name: stripe-billing
description: Use when the operator asks you to bill or refund through Stripe - create a payment link, draft an invoice, issue a refund - so money moves only through a reviewed, approved action.
---

# stripe-billing - propose a money-moving action

Turn a billing request into a precise, reviewable Stripe action - never an unattended charge.

## When to use

- The operator says "send them an invoice", "make a payment link for…", "refund that charge".

## Steps

1. Look up the customer/charge first (see stripe-lookup) so you act on the right record.
2. State the exact action in plain terms: amount, currency, customer, and what it does.
3. Propose it; moving money is outward and irreversible, so it surfaces as an approval card - wait.
4. After approval, return the payment link / invoice / refund id and confirm the amount.

## Rules

- Every charge, refund, or subscription change is human-gated - no exceptions, no batching around it.
- Quote amounts exactly; if the request is ambiguous about amount or recipient, ask before proposing.
