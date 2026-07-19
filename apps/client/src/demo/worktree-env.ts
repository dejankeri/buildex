// Derive a per-worktree demo environment (demo dir + non-colliding ports) so multiple git
// worktrees can each run the local app side by side. Deterministic: the same worktree path always
// yields the same dir and the same base ports (bookmarkable URL, easy reconnect); a free-port
// fallback steps the pair upward only when the derived ports are already in use, so two worktrees
// never hard-collide. Pure + injectable (isPortFree) so it is unit-tested with no network.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface WorktreeEnv {
  demoDir: string;
  consolePort: number;
  gatewayPort: number;
}

// The deterministic part: no I/O. Base ports sit in an even-console / odd-gateway band well clear
// of the legacy 4317/4318 defaults, so `npm run demo` on the flat ~/.buildex-demo is never disturbed.
export function deriveBase(worktreeRoot: string, homeDir: string): WorktreeEnv {
  const h = createHash("sha256").update(worktreeRoot).digest();
  const slug = basename(worktreeRoot);
  const short = h.toString("hex").slice(0, 6);
  const offset = h.readUInt16BE(0) % 100; // 0..99
  const consolePort = 4400 + offset * 2; // even, 4400..4598
  return {
    demoDir: join(homeDir, ".buildex-demo", `${slug}-${short}`),
    consolePort,
    gatewayPort: consolePort + 1, // odd, so it can never equal another worktree's console port
  };
}

// Walk the base pair upward (by 2, preserving the even-console/odd-gateway invariant) until both
// ports are free. Deterministic when the base pair is free; only drifts on a real collision.
export async function deriveWorktreeEnv(opts: {
  worktreeRoot: string;
  homeDir?: string;
  isPortFree: (port: number) => boolean | Promise<boolean>;
  maxTries?: number;
}): Promise<WorktreeEnv> {
  const homeDir = opts.homeDir ?? homedir();
  const base = deriveBase(opts.worktreeRoot, homeDir);
  const maxTries = opts.maxTries ?? 50;
  let consolePort = base.consolePort;
  for (let i = 0; i < maxTries; i++) {
    const gatewayPort = consolePort + 1;
    if ((await opts.isPortFree(consolePort)) && (await opts.isPortFree(gatewayPort))) {
      return { demoDir: base.demoDir, consolePort, gatewayPort };
    }
    consolePort += 2;
  }
  throw new Error(`no free console/gateway port pair near ${base.consolePort} after ${maxTries} tries`);
}
