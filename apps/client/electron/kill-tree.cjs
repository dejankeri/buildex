"use strict";
// Windows has no job objects behind child_process, so killing a process does NOT kill its
// descendants. The dev daemon is spawned through the npm .cmd shim with shell:true, which makes the
// returned child cmd.exe - killing it leaves the npx -> node/tsx tree alive, still holding the demo
// port. The next launch then spawns a daemon that dies on bind (its error lost to inherited stdio)
// while waitForDaemon gets a healthy /healthz from the ORPHAN, so the window silently opens onto a
// stale daemon running old code.
//
// taskkill /T fells the whole tree - but it must REPLACE child.kill(), not follow it: killing the
// parent first removes the pid /T needs to walk, and taskkill then reports "process not found"
// while the grandchildren keep running. Verified both ways against a real spawned tree.
const { spawnSync: nodeSpawnSync } = require("node:child_process");

/** Stop `child` and every process it spawned. Falls back to child.kill() when taskkill is
 *  unavailable or fails, so behaviour is never worse than before. */
function killProcessTree(child, deps) {
  const platform = (deps && deps.platform) || process.platform;
  const spawnSync = (deps && deps.spawnSync) || nodeSpawnSync;
  if (platform === "win32" && child && typeof child.pid === "number") {
    const r = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    if (r && r.status === 0) return;
  }
  if (child && typeof child.kill === "function") child.kill();
}

module.exports = { killProcessTree };
