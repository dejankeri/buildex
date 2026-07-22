import { createSandboxWorkspace, destroySandboxWorkspace, type SandboxDeps, type SandboxWorkspace } from "../brain/sandbox.js";
import type { PackManifest } from "../brain/catalog.js";
import { PACK_KEY_PREFIX, writeMcpEntries } from "@buildex/connectors";

/**
 * Mint a throwaway workspace and write the agent-facing .mcp.json pin.
 * Guards: m.sandbox must exist, m.mcp.url must exist, m.apiKey must exist.
 * Throws operator-readably if any guard fails.
 * Merges into existing .mcp.json (the Claude Code format) without clobbering other entries.
 */
export async function mintAndPin(
  m: PackManifest,
  secret: string,
  opts: { workspace: string; runName: string; host: string },
  deps: SandboxDeps,
): Promise<SandboxWorkspace> {
  // Guard: sandbox face must exist
  if (!m.sandbox) throw new Error("pack has no sandbox face");

  // Guard: mcp face must exist with http kind and url
  if (!m.mcp || m.mcp.kind !== "http" || !m.mcp.url) {
    throw new Error("pack has no sandbox face (missing mcp-bearer http surface)");
  }

  // Guard: apiKey face must exist
  if (!m.apiKey || m.apiKey.transport !== "mcp-bearer") {
    throw new Error("pack has no mcp-bearer api-key face (the minted key needs it to ride)");
  }

  // Mint the workspace
  const ws = await createSandboxWorkspace(m.sandbox, secret, { name: opts.runName, host: opts.host }, deps);

  // Build the pin entry with the minted key and mcpUrl override
  const header = m.apiKey.header ?? "Authorization";
  const prefix = m.apiKey.prefix ?? "Bearer ";
  const mcpUrl = ws.mcpUrl ?? m.mcp.url;

  // Merge the pin into the workspace's .mcp.json via the shared machinery (mirrors wiring.ts's
  // pack re-pinning): only this one key is touched, so an existing .mcp.json's other entries -
  // the gateway registration, operator-configured servers - are preserved untouched.
  writeMcpEntries(opts.workspace, {
    [`${PACK_KEY_PREFIX}${m.id}`]: {
      type: "http",
      url: mcpUrl,
      headers: {
        [header]: `${prefix}${ws.key}`,
      },
    },
  });

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
