#!/usr/bin/env node
// Guard against Electron version drift.
//
// apps/client/electron-builder.yml pins `electronVersion:` to an EXACT version so electron-builder
// can resolve the platform binaries (the root devDep is a range, which it can't compute a fixed
// version from). If someone bumps the root `electron` dependency without updating that pin, the
// packaged app would ship a different Electron than the one installed/tested. This script fails the
// build when the pinned version and the version actually resolved in package-lock.json disagree.
//
// Plain node, no dependencies. Paths are resolved relative to this file, so CWD does not matter.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const builderYmlPath = join(repoRoot, 'apps', 'client', 'electron-builder.yml');
const lockPath = join(repoRoot, 'package-lock.json');

function fail(msg) {
  console.error(`check-electron-version: ${msg}`);
  process.exit(1);
}

// 1) Pinned version from electron-builder.yml (simple line scan — avoids a YAML dependency).
let pinned;
try {
  const yml = readFileSync(builderYmlPath, 'utf8');
  const m = yml.match(/^\s*electronVersion:\s*["']?([^"'\s#]+)/m);
  if (!m) fail(`no \`electronVersion:\` found in ${builderYmlPath}`);
  pinned = m[1];
} catch (err) {
  fail(`cannot read ${builderYmlPath}: ${err.message}`);
}

// 2) Version actually resolved for electron in the lockfile.
let resolved;
try {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const pkg = lock.packages && lock.packages['node_modules/electron'];
  if (!pkg || !pkg.version) fail(`no resolved \`node_modules/electron\` entry in ${lockPath}`);
  resolved = pkg.version;
} catch (err) {
  fail(`cannot read ${lockPath}: ${err.message}`);
}

if (pinned !== resolved) {
  fail(
    `drift: electron-builder.yml pins electronVersion=${pinned} but package-lock.json resolves ` +
      `electron=${resolved}. Update electronVersion in apps/client/electron-builder.yml to ${resolved} ` +
      `(and keep the root package.json electron range compatible).`,
  );
}

console.log(`check-electron-version: OK (electron ${resolved} pinned and resolved match)`);
