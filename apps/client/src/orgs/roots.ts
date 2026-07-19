// Where the org registry lives on disk. Three cases, in precedence order:
//   1. BUILDEX_ORGS_ROOT explicitly set  → honor it (tests, power users, custom installs).
//   2. Packaged app (an app-data dir) → `<appData>/orgs` (e.g. ~/Library/Application Support/BuildEx/orgs).
//   3. Dev / demo                     → `<BUILDEX_DEMO_DIR|~/.buildex-demo>/orgs`, so it rides the same
//      per-worktree demo dir the launchers already isolate (demo/worktree-env.ts) — different
//      worktrees never share an orgs root.
import { join } from "node:path";

export interface ResolveOrgsRootOpts {
  env?: NodeJS.ProcessEnv;
  /** The Electron app's userData dir when packaged; absent in dev. */
  appDataDir?: string;
  /** Home dir (injectable for tests); defaults to os.homedir() at the call site. */
  homeDir: string;
}

export function resolveOrgsRoot(opts: ResolveOrgsRootOpts): string {
  const env = opts.env ?? process.env;
  const explicit = env["BUILDEX_ORGS_ROOT"];
  if (explicit) return explicit;
  if (opts.appDataDir) return join(opts.appDataDir, "orgs");
  const demoDir = env["BUILDEX_DEMO_DIR"] || join(opts.homeDir, ".buildex-demo");
  return join(demoDir, "orgs");
}
