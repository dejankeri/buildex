---
name: stripe-lookup
description: Use when the operator asks about a customer, payment, invoice, or subscription in Stripe - to answer from live billing data rather than memory before acting.
---

# stripe-lookup - read the billing state of the world

Pull the relevant Stripe record into the conversation before you reason about money.

## When to use

- The operator asks "did X pay?", "what's this customer on?", "when does this renew?".
- You are about to change billing and need the current state first.

## Steps

1. Search Stripe for the customer, payment, invoice, or subscription with the Stripe tools.
2. Read the record fully - status, amount, currency, and dates - before summarizing.
3. If several records match (same email, multiple subscriptions), list them and ask which.
4. Report exact figures and the record link; never round or guess an amount.

## Rules

- Reading Stripe is safe and runs freely; **moving money** - charges, refunds, payment links,
  subscription changes - waits for the operator's approval. Never assume permission to bill.
