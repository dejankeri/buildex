// Anonymous sign-up: the operator never leaves the app. An anonymous Supabase user is minted
// no-browser (sign-in.ts's signInAnonymously), traded at /session for the same
// machineToken/refreshToken/repos triple provisioning uses, then handed to the same
// persist-then-attach tail as every other entry point (open-account.ts).
//
// The sandbox guard runs FIRST, before signInAnonymously - not just before persistAndAttach's own
// (redundant) guard. persistAndAttach guards against spending an already-minted credential, but for
// this path the anon Supabase user IS the credential: creating one for a local-forever sandbox org
// would leave a zombie anonymous account server-side for an org that can never attach. Guarding here
// means a sandbox org never even reaches Supabase.
import { postSession } from "./session-client.js";
import { persistAndAttach } from "./open-account.js";
import type { SupabaseAuthClient } from "./sign-in.js";
import type { AccountStore } from "./account-store.js";
import type { SyncEngine } from "../sync/engine.js";

export interface SignUpAnonymousDeps {
  supabase: SupabaseAuthClient;
  account: AccountStore;
  engine: SyncEngine;
  /** The org's local roots (attach maps each to its remote by slot, so local names need not match). */
  roots: { name: string; dir: string }[];
  /** True for the local-forever sandbox org - it refuses to attach before anything irreversible runs. */
  sandbox: boolean;
  fetch: typeof fetch;
  baseUrl: string;
  /** Passed to /session as the machine name (e.g. os.hostname()). */
  machineName: string;
}

export async function signUpAnonymous(
  deps: SignUpAnonymousDeps,
  input: { companyName: string },
): Promise<{ state: "connected" | "needs-help" }> {
  if (deps.sandbox) throw new Error("the sandbox org is local-only and cannot attach an account");
  const { jwt } = await deps.supabase.signInAnonymously();
  const result = await postSession(
    { fetch: deps.fetch, baseUrl: deps.baseUrl },
    { jwt, companyName: input.companyName, machineName: deps.machineName },
  );
  return persistAndAttach(
    { account: deps.account, engine: deps.engine, roots: deps.roots, sandbox: deps.sandbox },
    deps.baseUrl,
    result,
  );
}
