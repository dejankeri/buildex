import { createSandboxWorkspace, destroySandboxWorkspace, type SandboxDeps, type SandboxWorkspace } from "../brain/sandbox.js";
import type { PackManifest } from "../brain/catalog.js";
import { PACK_KEY_PREFIX, writeMcpEntries } from "@buildex/connectors";

/** The pin's ride: an http mcp face to point at, and an mcp-bearer apiKey face saying how the key
 *  travels. Shared guard for both lanes - throws operator-readably, returns the resolved transport. */
function requireBearerMcp(m: PackManifest): { url: string; header: string; prefix: string } {
  if (!m.mcp || m.mcp.kind !== "http" || !m.mcp.url) {
    throw new Error("pack has no http mcp face (nothing to pin a key onto)");
  }
  if (!m.apiKey || m.apiKey.transport !== "mcp-bearer") {
    throw new Error("pack has no mcp-bearer api-key face (the pinned key needs it to ride)");
  }
  return { url: m.mcp.url, header: m.apiKey.header ?? "Authorization", prefix: m.apiKey.prefix ?? "Bearer " };
}

/**
 * Write the agent-facing .mcp.json pin for a caller-supplied url + key - the local lane, where the
 * key was minted by hand on a locally running provider and no sandbox endpoints exist. Pure local
 * write, no fetch. Merges into existing .mcp.json (the Claude Code format) via the shared machinery
 * (mirrors wiring.ts's pack re-pinning), so other entries - the gateway registration,
 * operator-configured servers - are preserved untouched.
 */
export function pinKey(m: PackManifest, opts: { workspace: string; url: string; key: string }): void {
  const { header, prefix } = requireBearerMcp(m);
  writeMcpEntries(opts.workspace, {
    [`${PACK_KEY_PREFIX}${m.id}`]: {
      type: "http",
      url: opts.url,
      headers: {
        [header]: `${prefix}${opts.key}`,
      },
    },
  });
}

/**
 * Mint a throwaway workspace and write the agent-facing .mcp.json pin.
 * Guards: m.sandbox must exist, plus pinKey's ride guards - all BEFORE any fetch.
 * Throws operator-readably if any guard fails.
 */
export async function mintAndPin(
  m: PackManifest,
  secret: string,
  opts: { workspace: string; runName: string; host: string },
  deps: SandboxDeps,
): Promise<SandboxWorkspace> {
  if (!m.sandbox) throw new Error("pack has no sandbox face");
  const { url } = requireBearerMcp(m);

  const ws = await createSandboxWorkspace(m.sandbox, secret, { name: opts.runName, host: opts.host }, deps);

  // The minted key rides the same pin the local lane uses; a sandbox-hosted provider may hand back
  // its own mcp url (mcpUrlPath), which overrides the pack's. If the pin write fails, the caller
  // never receives the workspace handle and could not destroy it - so destroy it HERE, or the mint
  // leaks silently (a leaked live credential is the worst failure this module can produce).
  try {
    pinKey(m, { workspace: opts.workspace, url: ws.mcpUrl ?? url, key: ws.key });
  } catch (pinError) {
    try {
      await destroySandboxWorkspace(m.sandbox, secret, ws.id, deps);
    } catch (destroyError) {
      console.error("Failed to destroy sandbox workspace after pin failure:", destroyError);
    }
    throw pinError;
  }

  return ws;
}

/**
 * Mint a sandbox workspace, run a function with it, then destroy the workspace. Destroy ALWAYS
 * runs. If fn throws, destroy is best-effort cleanup: its failure is only logged, and fn's error
 * is what rethrows (that's the actionable one for the caller). If fn succeeds, a destroy failure
 * is the only problem left, so it is NOT swallowed - same contract as destroySandboxWorkspace's
 * docstring: a silently leaked workspace is worse than a loud one.
 */
export async function withSandbox<T>(
  m: PackManifest,
  secret: string,
  opts: { workspace: string; runName: string; host: string },
  deps: SandboxDeps,
  fn: (ws: SandboxWorkspace) => Promise<T>,
): Promise<T> {
  const ws = await mintAndPin(m, secret, opts, deps);

  let result: T;
  try {
    result = await fn(ws);
  } catch (fnError) {
    try {
      await destroySandboxWorkspace(m.sandbox!, secret, ws.id, deps);
    } catch (destroyError) {
      console.error("Failed to destroy sandbox workspace:", destroyError);
    }
    throw fnError;
  }

  await destroySandboxWorkspace(m.sandbox!, secret, ws.id, deps);
  return result;
}
