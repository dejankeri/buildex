// The sign-in counterpart to provision-client's /provision: trades a signed JWT (from the
// system-browser sign-in flow in sign-in.ts) for the same machineToken/refreshToken/repos triple.
// Deliberately thin - it reuses provision-client's `post()` outright rather than re-implementing
// the URL-join / network-error mapping / non-2xx handling / body-validation guard, so both server
// calls are exercised through ONE tested path instead of two that could drift apart.
import { post } from "./provision-client.js";
import type { ProvisionResult } from "./provision-client.js";

export function postSession(
  deps: { fetch: typeof fetch; baseUrl: string },
  args: { jwt: string; companyName?: string; machineName: string },
): Promise<ProvisionResult> {
  // companyName is optional (the setup-code sign-in path never has one); JSON.stringify drops an
  // undefined value entirely, so omitting it here keeps the existing /session body unchanged for
  // every caller that doesn't pass one.
  return post(deps, "/session", { jwt: args.jwt, companyName: args.companyName, machineName: args.machineName });
}
