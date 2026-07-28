const { statSync } = require('node:fs')
const { join } = require('node:path')

// BuildEx-owned packaging gate. `files` in config/electron-builder.config.cjs is a
// BLACKLIST: anything sitting at the repo root ships inside app.asar unless it is
// explicitly named. Two real incidents motivated this file, both on the same day:
//
//   1. A 4.4 GB folder of previous release artifacts was parked at the repo root
//      during a release. It was packed into app.asar, producing a 3.9 GB DMG that
//      was signed and notarized before anything noticed.
//   2. v0.1.7 shipped this repo's own `.claude/` — agent settings plus a generated
//      company-context.md naming a local filesystem path — inside the public DMG.
//
// Neither was caught by .gitignore, because gitignore has no bearing on packaging.
// So assert on the packed artifact itself.

// Why a ceiling and not an exact size: the bundle grows every release. This only
// has to separate "normal" (~1 GB) from "something enormous got swept in" (>3 GB).
const MAX_ASAR_BYTES = 1_600_000_000

// Root entries that are development-only. A match means the asar picked up
// something from the working tree that has no business shipping.
const FORBIDDEN_ROOT_ENTRIES = new Set([
  '.claude',
  '.buildex',
  '.mcp.json',
  '.env',
  'test-results',
  'pr-evidence',
  'coverage',
  '.wrangler'
])

// Why a prefix list too: release runs leave differently-named output dirs behind
// (dist, dist-0.1.6-old, dist-backup). Catch the family, not one spelling.
const FORBIDDEN_ROOT_PREFIXES = ['dist']

function findForbiddenRootEntries(rootEntries) {
  return rootEntries.filter(
    (entry) =>
      FORBIDDEN_ROOT_ENTRIES.has(entry) ||
      FORBIDDEN_ROOT_PREFIXES.some((prefix) => entry === prefix || entry.startsWith(`${prefix}-`))
  )
}

function readAsarRootEntries(asarPath) {
  // Required lazily: electron-builder owns this dependency, and the unit test
  // exercises findForbiddenRootEntries without needing a real asar on disk.
  const { listPackage } = require('@electron/asar')
  const rootEntries = new Set()
  for (const entry of listPackage(asarPath, { isPack: false })) {
    // listPackage yields absolute-style paths inside the archive ("/out/main/...").
    const segments = entry.split('/').filter(Boolean)
    if (segments.length > 0) {
      rootEntries.add(segments[0])
    }
  }
  return [...rootEntries]
}

function verifyPackagedAsarContents(resourcesDir) {
  const asarPath = join(resourcesDir, 'app.asar')

  const { size } = statSync(asarPath)
  if (size > MAX_ASAR_BYTES) {
    throw new Error(
      `[verify-packaged-asar-contents] app.asar is ${(size / 1e9).toFixed(2)} GB, over the ` +
        `${(MAX_ASAR_BYTES / 1e9).toFixed(2)} GB ceiling. Something large was swept in from the ` +
        `repo root — check for build output or archives sitting beside package.json.`
    )
  }

  const forbidden = findForbiddenRootEntries(readAsarRootEntries(asarPath))
  if (forbidden.length > 0) {
    throw new Error(
      `[verify-packaged-asar-contents] app.asar contains development-only entries: ` +
        `${forbidden.join(', ')}. These ship to users inside the DMG. Add them to the \`files\` ` +
        `blacklist in config/electron-builder.config.cjs (.gitignore does not exclude them).`
    )
  }

  console.log(
    `[verify-packaged-asar-contents] OK — app.asar is ${(size / 1e9).toFixed(2)} GB with no dev-only root entries`
  )
}

module.exports = {
  verifyPackagedAsarContents,
  findForbiddenRootEntries,
  MAX_ASAR_BYTES
}
