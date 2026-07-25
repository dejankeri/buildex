#!/usr/bin/env npx tsx
// Founder tool: hard-delete a company from a running sync service - its operators, machines, setup
// tokens, permissions, audit rows, and its bare repos. `core` is never touched.
//
//   npx tsx scripts/delete-company.ts --base-url https://<host> --slug acme
//   npx tsx scripts/delete-company.ts --base-url https://<host> --slug acme --yes   # no prompt
//   npx tsx scripts/delete-company.ts --base-url https://<host> --list              # what exists
//
// This is what makes "sign in, test, start over clean" repeatable. It is NOT /s2s/revoke: revoke
// only drops grants, leaving the operator resolvable by Supabase sub and the slug taken, so the next
// sign-in returns a permission-less operator under `<slug>-2`. Only a hard delete starts over.
//
// IRREVERSIBLE. There is no second copy of a team or private repo on the server. The confirmation
// prompt is the last gate; --yes removes it for scripted use.
//
// The Supabase auth user is deliberately left alone: deletion is keyed on the operator row, so the
// same Google account simply creates a fresh company on its next sign-in.
//
// The service key is read from BUILDEX_SERVICE_KEY - never an argument, which would put it in the
// shell history and the process list.
import { createInterface } from "node:readline/promises";

export interface DeleteDeps {
  baseUrl: string;
  serviceKey: string;
  fetchImpl: typeof fetch;
}

export class S2sError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "S2sError";
  }
}

/** DELETE a company by slug. Returns the repos that were removed. Throws S2sError(404) when the
 *  slug is unknown, so a caller can tell "already gone" from "the call failed". */
export async function deleteCompany(deps: DeleteDeps, slug: string): Promise<{ slug: string; repos: string[] }> {
  const res = await deps.fetchImpl(`${deps.baseUrl}/s2s/companies/${encodeURIComponent(slug)}`, {
    method: "DELETE",
    headers: { "x-service-key": deps.serviceKey },
  });
  if (!res.ok) throw new S2sError(`delete ${slug} failed: ${res.status} ${await res.text()}`, res.status);
  return (await res.json()) as { slug: string; repos: string[] };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const baseUrl = (arg("base-url") ?? "").replace(/\/+$/, "");
  const slug = arg("slug");
  const yes = process.argv.includes("--yes");
  const serviceKey = process.env["BUILDEX_SERVICE_KEY"] ?? "";

  if (!baseUrl || !slug) {
    console.error("usage: delete-company.ts --base-url https://<host> --slug <slug> [--yes]");
    process.exit(2);
  }
  if (!serviceKey) {
    console.error("BUILDEX_SERVICE_KEY is not set - export it before running (never pass it as an argument).");
    process.exit(2);
  }

  if (!yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `Permanently delete company "${slug}" and its repos from ${baseUrl}?\nThis cannot be undone. Type the slug to confirm: `,
    );
    rl.close();
    if (answer.trim() !== slug) {
      console.error("Confirmation did not match - nothing was deleted.");
      process.exit(1);
    }
  }

  try {
    const out = await deleteCompany({ baseUrl, serviceKey, fetchImpl: fetch }, slug);
    console.log(`Deleted "${out.slug}". Repos removed: ${out.repos.length ? out.repos.join(", ") : "(none)"}`);
    console.log("The same email can now sign in again and get this slug back.");
  } catch (e) {
    if (e instanceof S2sError && e.status === 404) {
      console.error(`No company with slug "${slug}" - nothing to delete.`);
      process.exit(1);
    }
    throw e;
  }
}

// Only run when invoked directly, so the exported helper stays importable from tests.
if (process.argv[1]?.endsWith("delete-company.ts")) {
  await main();
}
