// electron-builder afterPack hook (macOS): rename the Electron *helper* processes to carry the product
// name in their CFBundleName.
//
// Why: electron-builder renames the helper .app bundles and their CFBundleExecutable/CFBundleDisplayName
// to "BuildEx Helper (…)", but leaves each helper Info.plist's *CFBundleName* as the stock
// "Electron Helper (…)". macOS attributes a TCC permission prompt (local network, files, automation, …)
// to the *responsible process* - which is one of these helpers, not the main app - and several of those
// prompts read CFBundleName. The result is a dialog that says "Electron would like to…" instead of
// "BuildEx would like to…". Rewriting CFBundleName to match closes that gap.
//
// This runs AFTER packaging but BEFORE code signing, so the edited plists are the ones that get signed
// (no signature invalidation). No-op on non-mac targets.
"use strict";

const path = require("node:path");
const { readdirSync, existsSync } = require("node:fs");
const { execFileSync } = require("node:child_process");

const plistBuddy = "/usr/libexec/PlistBuddy";

/** Read a plist key via PlistBuddy, or null if it isn't set. */
function readKey(plist, key) {
  try {
    return execFileSync(plistBuddy, ["-c", `Print :${key}`, plist], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** Set (or add) a string key via PlistBuddy. */
function setKey(plist, key, value) {
  try {
    execFileSync(plistBuddy, ["-c", `Set :${key} ${value}`, plist]);
  } catch {
    execFileSync(plistBuddy, ["-c", `Add :${key} string ${value}`, plist]);
  }
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const productName = context.packager.appInfo.productFilename; // "BuildEx"
  const appPath = path.join(context.appOutDir, `${productName}.app`);
  const frameworks = path.join(appPath, "Contents", "Frameworks");
  if (!existsSync(frameworks)) return;

  let fixed = 0;
  for (const entry of readdirSync(frameworks)) {
    if (!entry.endsWith(" Helper.app") && !/ Helper \(.*\)\.app$/.test(entry)) continue;
    const plist = path.join(frameworks, entry, "Contents", "Info.plist");
    if (!existsSync(plist)) continue;
    // The correct name is already in CFBundleDisplayName ("BuildEx Helper (…)"); mirror it into
    // CFBundleName. Fall back to deriving from the folder name if DisplayName is somehow absent.
    const desired = readKey(plist, "CFBundleDisplayName") || entry.replace(/\.app$/, "");
    if (readKey(plist, "CFBundleName") !== desired) {
      setKey(plist, "CFBundleName", desired);
      fixed++;
    }
  }
  if (fixed > 0) console.log(`  • afterPack: renamed CFBundleName on ${fixed} helper bundle(s) → "${productName} Helper …"`);
};
