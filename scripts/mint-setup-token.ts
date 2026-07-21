#!/usr/bin/env npx tsx
// Founder tool: onboard an operator against a running sync service and print their setup token.
// This is the other half of the paste-a-token front door - without it there is nothing to paste.
//
//   npx tsx scripts/mint-setup-token.ts --base-url https://<host> --onboard \
//     --company-slug acme --company-name "Acme Labs" --email operator@example.test
//
//   npx tsx scripts/mint-setup-token.ts --base-url https://<host> --operator-id <id>
//
// The service key is read from BUILDEX_SERVICE_KEY - never passed as an argument, which would put it
// in the shell history and the process list.
import { randomUUID } from "node:crypto";

export interface MintDeps {
  baseUrl: string;
  serviceKey: string;
  fetchImpl: typeof fetch;
}

/** Thrown by s2s() on a non-OK response. Carries the numeric status so callers can branch on it
 * without parsing it back out of the message string. */
export class S2sError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "S2sError";
  }
}

async function s2s(deps: MintDeps, path: string, body: unknown): Promise<unknown> {
  const res = await deps.fetchImpl(`${deps.baseUrl}${path}`, {
    method: "POST",
    headers: { "x-service-key": deps.serviceKey, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new S2sError(`${path} failed: ${res.status} ${await res.text()}`, res.status);
  return res.json();
}

/** Create a company + operator, then mint their setup token. Returns the token. */
export async function onboard(
  deps: MintDeps,
  opts: { companySlug: string; companyName: string; email: string },
): Promise<{ companyId: string; operatorId: string; setupToken: string }> {
  const companyId = `co_${randomUUID()}`;
  const operatorId = `op_${randomUUID()}`;
  try {
    await s2s(deps, "/s2s/companies", { id: companyId, slug: opts.companySlug, name: opts.companyName });
  } catch (err) {
    // A 500 is the shape a UNIQUE violation on companies.slug takes (it falls through the server's
    // catch-all). Every other failure - a 401 from a bad service key, a validation error, a network
    // rejection - is not consistent with a duplicate slug, so it must propagate untouched rather than
    // mislead the operator with an invented diagnosis.
    if (err instanceof S2sError && err.status === 500) {
      throw new Error(
        `could not create company "${opts.companySlug}" - a company with that slug probably already ` +
          `exists (companies.slug is unique). If the operator already exists, re-issue their token with ` +
          `--operator-id <id> instead of --onboard. Original error: ${err.message}`,
      );
    }
    throw err;
  }
  await s2s(deps, "/s2s/operators", { id: operatorId, companyId, email: opts.email });
  const { setupToken } = (await s2s(deps, "/s2s/setup-tokens", { operatorId })) as { setupToken: string };
  return { companyId, operatorId, setupToken };
}

/** Mint a fresh setup token for an operator who already exists (a second machine, or a re-issue). */
export async function mintForOperator(deps: MintDeps, operatorId: string): Promise<string> {
  const { setupToken } = (await s2s(deps, "/s2s/setup-tokens", { operatorId })) as { setupToken: string };
  return setupToken;
}

/** Look up a `--flag value` pair. Returns undefined if the flag is absent, trailing, or immediately
 * followed by another flag - e.g. `--company-slug --email a@b.test` must not silently set
 * companySlug to "--email". */
export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith("--")) return undefined;
  return value;
}

async function main(): Promise<void> {
  const baseUrl = (arg("base-url") ?? "").replace(/\/+$/, "");
  const serviceKey = process.env["BUILDEX_SERVICE_KEY"] ?? "";
  if (!baseUrl) throw new Error("--base-url is required");
  if (!serviceKey) throw new Error("BUILDEX_SERVICE_KEY must be set in the environment");

  const deps: MintDeps = { baseUrl, serviceKey, fetchImpl: fetch };

  if (process.argv.includes("--onboard")) {
    const companySlug = arg("company-slug");
    const companyName = arg("company-name");
    const email = arg("email");
    if (!companySlug || !companyName || !email) {
      throw new Error("--onboard requires --company-slug, --company-name and --email");
    }
    const out = await onboard(deps, { companySlug, companyName, email });
    console.log(`company:  ${out.companyId}`);
    console.log(`operator: ${out.operatorId}`);
    console.log(`\nsetup token (one-time, expires in 10 minutes):\n${out.setupToken}`);
    return;
  }

  const operatorId = arg("operator-id");
  if (!operatorId) throw new Error("pass --onboard, or --operator-id <id> to re-issue");
  console.log(await mintForOperator(deps, operatorId));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
