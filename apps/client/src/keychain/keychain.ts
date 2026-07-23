// The keychain seam (invariant 4). Workspace-scoped secrets - the per-machine
// git token and connector credentials - live in the OS keychain, NEVER in a config file, a repo, a
// log, or a synced path. This interface + in-memory impl let every consumer be tested hermetically,
// and the secrets invariant scan proves nothing leaks; SystemKeychain (below) is the persistent
// OS-backed impl for real use.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { WindowsKeychain, defaultWinCredRunner, windowsKeychainAvailable, type WinCredRunner } from "./windows.js";

export interface Keychain {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
  /** Remove EVERY secret under this keychain's workspace service in one call. The seam for closing the
   *  path-reuse edge (invariant 6): a workspace path reused by a new company must never inherit the old
   *  one's OS-vault namespace, and the OS vault lives outside the workspace dir, so deleting the dir can
   *  never reach it. Also the primitive behind an in-app "remove all data". Best-effort by contract - it
   *  swallows backend failures rather than throw, because a purge must not block a fresh provision. */
  clear(): void;
}

/** Process-memory keychain for tests and ephemeral runs. Values never touch disk. */
export class InMemoryKeychain implements Keychain {
  private readonly store = new Map<string, string>();
  get(key: string): string | undefined {
    return this.store.get(key);
  }
  set(key: string, value: string): void {
    this.store.set(key, value);
  }
  delete(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

/** Runs the macOS `security` CLI. Injected so SystemKeychain is unit-testable without the real OS
 *  keychain. status mirrors the CLI's exit code (44 = item-not-found). */
export type SecurityRunner = (args: string[]) => { status: number; stdout: string };

const SECURITY_BIN = "/usr/bin/security";

function defaultRunner(): SecurityRunner {
  return (args) => {
    try {
      // Args array (never a shell) → no shell history/quoting; same discipline as shelling to git.
      const stdout = execFileSync(SECURITY_BIN, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      return { status: 0, stdout };
    } catch (e) {
      const err = e as { status?: number; stdout?: Buffer | string };
      return { status: typeof err.status === "number" ? err.status : 1, stdout: err.stdout?.toString() ?? "" };
    }
  };
}

/** Persistent, OS-backed keychain: shells to macOS `security` (generic passwords), so secrets survive
 *  a daemon restart while staying out of every repo/log/synced/config path (invariant 4). Values are
 *  base64-encoded so any bytes round-trip cleanly through the CLI's `-w`/trailing-newline convention.
 *  NOTE: the value passes as an argv to `security` - briefly visible to same-user `ps`; a documented,
 *  low, same-user exposure (the daemon runs as the operator). */
export class SystemKeychain implements Keychain {
  constructor(
    private readonly service: string,
    private readonly run: SecurityRunner = defaultRunner(),
  ) {}

  get(key: string): string | undefined {
    const r = this.run(["find-generic-password", "-s", this.service, "-a", key, "-w"]);
    if (r.status !== 0) return undefined; // 44 = not found
    try {
      return Buffer.from(r.stdout.replace(/\n$/, ""), "base64").toString("utf8");
    } catch {
      return undefined;
    }
  }

  set(key: string, value: string): void {
    const encoded = Buffer.from(value, "utf8").toString("base64");
    const r = this.run(["add-generic-password", "-U", "-s", this.service, "-a", key, "-w", encoded]);
    if (r.status !== 0) throw new Error(`keychain set failed for "${key}" (security exit ${r.status})`);
  }

  delete(key: string): void {
    this.run(["delete-generic-password", "-s", this.service, "-a", key]); // 44 (not found) is fine
  }

  /** `security delete-generic-password -s <service>` (no account) removes ONE generic item under this
   *  workspace's service; looping until a non-zero exit (44 = none left) clears the whole namespace.
   *  Bounded so a misbehaving runner that never reports "not found" can't spin the daemon forever, and
   *  never throws - a purge is best-effort and must not block the provision that triggered it. */
  clear(): void {
    for (let i = 0; i < KEYCHAIN_CLEAR_MAX; i++) {
      if (this.run(["delete-generic-password", "-s", this.service]).status !== 0) return;
    }
  }
}

/** Upper bound on the by-service delete loop. Far above any realistic per-workspace key count (a handful
 *  of connectors + a git token), so it only ever caps a runner that never returns "not found". */
export const KEYCHAIN_CLEAR_MAX = 10_000;

/** A stable per-workspace keychain service id, so companies/workspaces never collide (invariant 6). */
export function keychainService(workspace: string): string {
  return `buildex-${createHash("sha256").update(workspace).digest("hex").slice(0, 12)}`;
}

/** Pick a keychain implementation. "auto" (default) persists to the OS keychain when available - macOS
 *  `security`, Windows Credential Manager - else falls back to in-memory, NEVER a plaintext file, so the
 *  secrets invariant holds even without an OS keychain. "system" is an explicit opt-in that errors if
 *  unavailable. */
export function createKeychain(opts: {
  mode?: "auto" | "system" | "memory";
  workspace: string;
  run?: SecurityRunner;
  winRun?: WinCredRunner;
  platform?: string;
}): Keychain {
  const mode = opts.mode ?? "auto";
  if (mode === "memory") return new InMemoryKeychain();
  const platform = opts.platform ?? process.platform;

  // An injected runner means a test/host is supplying the backend - treat it as available.
  if (platform === "darwin" && (opts.run !== undefined || existsSync(SECURITY_BIN))) {
    return new SystemKeychain(keychainService(opts.workspace), opts.run ?? defaultRunner());
  }
  // The win32 backend is probed for real, injected runner or not: an existence check cannot tell a
  // working vault from one whose helper can never execute, and picking the latter reads as "nothing
  // stored" forever.
  if (platform === "win32" && windowsKeychainAvailable(opts.winRun)) {
    return new WindowsKeychain(keychainService(opts.workspace), opts.winRun ?? defaultWinCredRunner());
  }
  // No OS backend on this platform: "system" must not silently degrade; "auto" falls back to in-memory
  // (never a plaintext file, so the secrets invariant holds even without an OS keychain).
  if (mode === "system") throw new Error(`system keychain unavailable on ${platform} - no OS keychain backend`);
  return new InMemoryKeychain();
}
