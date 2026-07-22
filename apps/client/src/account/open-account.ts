// Open an account: the operator pastes a setup code, and this runs provision → persist → attach.
// Extracted from wiring.ts so the whole chain is testable in one place (it was previously an
// untested closure).
//
// The sandbox guard is FIRST, before anything irreversible, on purpose. `provision()` burns a
// one-time setup token server-side and `account.save()` writes a real company's tokens into the
// keychain - so running either for a local-forever sandbox org would leave a zombie account that
// reports "connected" yet can never sync (no remote was ever attached), breaking the hard rule that
// the sandbox refuses to attach and stays local. Guarding inside attachOrg alone is too late: by the
// time it throws, the token is spent and the credentials are on the keychain.
import { provision } from "./provision-client.js";
import { attachOrg } from "./attach.js";
import type { AccountStore } from "./account-store.js";
import type { SyncEngine } from "../sync/engine.js";

export interface OpenAccountDeps {
  fetch: typeof fetch;
  account: AccountStore;
  engine: SyncEngine;
  /** The org's local roots (attach maps each to its remote by slot, so local names need not match). */
  roots: { name: string; dir: string }[];
  /** True for the local-forever sandbox org - it refuses to attach before anything irreversible runs. */
  sandbox: boolean;
  /** Passed to /provision as the machine name (e.g. os.hostname()). */
  machineName: string;
}

export async function openAccount(
  deps: OpenAccountDeps,
  input: { baseUrl: string; setupToken: string },
): Promise<{ state: "connected" | "needs-help" }> {
  if (deps.sandbox) throw new Error("the sandbox org is local-only and cannot attach an account");
  const result = await provision(
    { fetch: deps.fetch, baseUrl: input.baseUrl },
    { setupToken: input.setupToken, machineName: deps.machineName },
  );
  deps.account.save(input.baseUrl, result);
  const res = await attachOrg({ engine: deps.engine, roots: deps.roots, repos: result.repos, sandbox: deps.sandbox });
  return { state: res.status === "needs-help" ? "needs-help" : "connected" };
}
