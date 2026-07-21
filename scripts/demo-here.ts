// Launch THIS git worktree's local app in an isolated demo environment, so several worktrees can
// run side by side. Derives a stable per-worktree demo dir + non-colliding console/gateway ports
// from the worktree path, exports them as the env vars the existing scripts already honor, and
// delegates to `npm run demo` (browser) or `npm run demo:app` (Electron).
// Usage:  tsx scripts/demo-here.ts [web|app]
import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename } from "node:path";
import net from "node:net";
import { deriveWorktreeEnv } from "../apps/client/src/demo/worktree-env.js";

const mode = process.argv[2] === "app" ? "app" : "web";
const worktreeRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

const isPortFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });

const { demoDir, consolePort, gatewayPort } = await deriveWorktreeEnv({
  worktreeRoot,
  homeDir: homedir(),
  isPortFree,
});

console.log(`
  worktree  ${basename(worktreeRoot)}
  console   http://127.0.0.1:${consolePort}
  gateway   ${gatewayPort}
  demoDir   ${demoDir}
`);

const env = {
  ...process.env,
  BUILDEX_DEMO_DIR: demoDir,
  BUILDEX_DEMO_PORT: String(consolePort),
  BUILDEX_DEMO_GATEWAY_PORT: String(gatewayPort),
};
const script = mode === "app" ? "demo:app" : "demo";
// On Windows `npm` is the npm.cmd shim, which modern Node refuses to spawn directly (EINVAL, per
// CVE-2024-27980) unless shell:true; POSIX keeps the plain spawn.
const isWin = process.platform === "win32";
const child = spawn(isWin ? "npm.cmd" : "npm", ["run", script], {
  cwd: worktreeRoot,
  env,
  stdio: "inherit",
  shell: isWin,
});
child.on("exit", (code) => process.exit(code ?? 0));
