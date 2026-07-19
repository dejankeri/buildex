# Security Policy

BuildEx is a local-first operating system for running a company on an agent + git + connectors.
Its whole pitch is a security posture — a human-gated approval boundary, hard company isolation, and
credentials the product never proxies. We take security reports seriously and want them to reach us
privately.

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.** Public issues are visible to
everyone before a fix exists.

Report privately, by either channel:

1. **GitHub private vulnerability reporting** (preferred) — on this repository, go to the
   **Security** tab → **Report a vulnerability**. This opens a private advisory only the maintainers
   can see.
2. **Email** — `security@buildexponential.org`. Encrypt if you can; if not, send a short note and
   we'll arrange a secure channel.

Please include: what you found, the impact you think it has, and the minimal steps (or a
proof-of-concept) to reproduce it. A concrete repro is the single most useful thing you can send.

## What to expect

This is a pre-1.0 project developed in the open. We will:

- **Acknowledge** your report within **3 business days**.
- Give you an initial **assessment** (accepted / need-more-info / not-a-vuln) within **10 business
  days**.
- Keep you updated as we work a fix, and **credit you** in the advisory when it ships — unless you'd
  rather stay anonymous.

We ask that you give us a reasonable window to fix an issue before disclosing it publicly. We don't
run a paid bug-bounty program yet.

## Scope

**In scope** — the code in this repository: the desktop client + local daemon (`apps/client`), the
sync service (`apps/sync`), the connector framework (`apps/connectors`), the toolkit
(`apps/toolkit`), and the shipped content packs (`packs/core`). The security-relevant invariants
these must hold are listed in [`CLAUDE.md`](CLAUDE.md) (§"The 10 invariants").

Especially interested in: anything that crosses the **human-gated approval boundary** (an outward or
irreversible action firing without an approval card), breaks **company isolation**, exposes a
**credential** the product is supposed to keep in the OS keychain, or defeats the **path
confinement** on the daemon's file APIs.

**Out of scope** — the model provider (Anthropic) and your agent's own credential store, which the
product deliberately never touches (invariant 4); third-party connectors' own servers; social
engineering; and anything requiring a pre-compromised operator machine.

## Supported versions

Pre-1.0: only the current `main` branch is supported. Fixes land on `main`; there is no back-porting
to older tags yet.

## Telemetry & privacy

**v1 telemetry: none.** The desktop app and daemon collect and transmit **no** usage analytics,
telemetry, or crash reporting. Your workspace content is plain git on your machine; the sync service
(when you opt into it) hosts your repositories and identity and runs no knowledge APIs. If this ever
changes, it will be an explicit, documented, opt-in decision — never a silent addition.
