// Connect an org's local roots to the cloud IN PLACE - never clone, never move, so existing local
// work is kept. Per root: point origin at the provisioned URL, fetch, then hand off to the engine
// that already knows every upstream state (empty, non-empty, divergent). core is read-only: it takes
// syncReadonly and is never pushed. The writable roots receive, then get ONE explicit first publish -
// connecting an account is the single moment the operator has unambiguously consented to sending
// everything they have. Idempotent per root: re-running re-points origin and is safe to resume.
import type { SyncEngine } from "../sync/engine.js";
import { slotOf } from "../brain/catalog.js";

export interface AttachResult {
  status: "connected" | "needs-help";
}

export async function attachOrg(deps: {
  engine: SyncEngine;
  roots: { name: string; dir: string }[];
  repos: { core: string; team: string; private: string };
  sandbox: boolean;
}): Promise<AttachResult> {
  if (deps.sandbox) throw new Error("the sandbox org is local-only and cannot attach an account");

  let needsHelp = false;
  const writable: string[] = [];

  for (const root of deps.roots) {
    const slot = slotOf(root.name);
    const url = slot === "core" ? deps.repos.core : slot === "team" ? deps.repos.team : slot === "private" ? deps.repos.private : undefined;
    if (!url) continue; // an unknown root slot has no remote to attach

    await deps.engine.addRemote(root.dir, url);

    if (slot === "core") {
      // Read-only. syncReadonly fetches and HARD-RESETS onto the remote - it does NOT back up local
      // divergence, because core carries no operator work (it is pack content, pull-only by design);
      // the manual-save design that supersedes this spec makes that discard explicit. Operator work
      // lives only in the writable roots below, which DO go through the engine's backup path.
      try {
        await deps.engine.syncReadonly(root.dir);
      } catch {
        /* offline: core is rebuilt from the remote on the next pull tick */
      }
    } else {
      const r = await deps.engine.receive(root.dir); // fetch + rebase onto origin/main
      // a revoke mid-attach (rare - the token was just minted) still means the operator must act
      if (r === "needs-help" || r === "reconnect") needsHelp = true;
      writable.push(root.dir);
    }
  }

  // The first publish - the operator's consent to send everything they already have.
  for (const dir of writable) {
    const r = await deps.engine.publish(dir);
    if (r === "needs-help" || r === "reconnect") needsHelp = true;
  }

  return { status: needsHelp ? "needs-help" : "connected" };
}
