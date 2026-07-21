"use strict";
// Electron's single-instance lock is keyed on the userData path, and app.setName("BuildEx") makes
// that path identical for every instance. Two worktrees running `npm run demo:app:here` therefore
// collide: the second gets no lock, quits, and focuses the FIRST worktree's window - breaking the
// "different worktrees never collide" guarantee that demo-here.ts exists to provide, on macOS just
// as much as on Windows.
//
// A per-worktree dev launch already has a unique, stable directory: BUILDEX_DEMO_DIR, whose basename
// is `<worktree>-<hash>`. Scoping userData inside it gives each worktree its own lock, and keeps
// `rm -rf <that demoDir>` a complete reset - including the lock - exactly as CLAUDE.md documents.
//
// Packaged and default launches set no BUILDEX_DEMO_DIR, so they keep the global lock, which is what
// it exists for: the installer's post-install launch racing a manual one.
const path = require("node:path");

/** The userData dir for this launch, or null to keep Electron's default (and the global lock). */
function scopedUserDataDir(env) {
  const demoDir = env && typeof env.BUILDEX_DEMO_DIR === "string" ? env.BUILDEX_DEMO_DIR.trim() : "";
  if (!demoDir) return null;
  return path.join(demoDir, "electron-userdata");
}

module.exports = { scopedUserDataDir };
