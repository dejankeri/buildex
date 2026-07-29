import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { CompanyMarketplace, CompanyMarketplaceList } from '../../shared/buildex-store-types'
import type { BrainLocation } from '../../shared/buildex-brain-types'

// The marketplaces a company adds for itself.
//
// The three bundled ones are the three we have a reason to trust by default.
// Everything else is a company saying where its own plugins live — an internal
// marketplace on a private host, a partner's, a fork of upstream's.
//
// It lives in the brain for the same reason the roster does: a marketplace only
// one machine can see makes the shelf different for every teammate, and the
// answer to "which apps does this company have" would depend on who you asked.
// Committed, it travels with a clone like every other company document.

export const COMPANY_MARKETPLACES_FILE_NAME = 'marketplaces.json'

/** Matches the ids the agent's CLI accepts, and keeps them safe as cache filenames. */
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/i
const REPO_SLUG_RE = /^[\w.-]+\/[\w.-]+$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Absolute path of the marketplace list inside a brain. */
export function companyMarketplacesPath(location: BrainLocation): string {
  return path.join(location.root, COMPANY_MARKETPLACES_FILE_NAME)
}

/**
 * How the file is referred to in the UI. Same reasoning as the roster: an
 * embedded brain's repo-relative path is useful, an external brain's is a path
 * into somebody else's checkout.
 */
export function companyMarketplacesDisplayPath(location: BrainLocation): string {
  return location.mode === 'embedded'
    ? path.posix.join(path.basename(location.root), COMPANY_MARKETPLACES_FILE_NAME)
    : COMPANY_MARKETPLACES_FILE_NAME
}

/**
 * Why what the operator typed cannot be fetched, or null when it can. Checked
 * before the network, so an obvious typo does not cost a request.
 */
export function marketplaceSourceProblem(candidate: {
  label: string
  repo: string
}): string | null {
  if (!candidate.label.trim()) {
    return 'Give it a name your team will recognise.'
  }
  // Why https only: this is fetched on every refresh, and a marketplace list is
  // a tracked file — a plain-http entry a teammate pulls would be a downgrade
  // nobody chose.
  const repo = candidate.repo.trim()
  if (!REPO_SLUG_RE.test(repo) && !/^https:\/\//i.test(repo)) {
    return 'Point at owner/repo, or an https URL to a marketplace.json.'
  }
  return null
}

/**
 * Why the id a marketplace declares cannot be used, or null when it can.
 *
 * This is not the operator's choice — it is the `name` inside marketplace.json,
 * because that is the key the agent records installs under. It is still checked:
 * an id colliding with a bundled one would shadow a marketplace nobody can
 * remove and make both read as the same installed plugin, and one that is not
 * filename-safe would escape the index cache directory.
 */
export function marketplaceIdProblem(id: string, reservedIds: readonly string[]): string | null {
  const trimmed = id.trim()
  if (!trimmed || !ID_RE.test(trimmed)) {
    return `“${trimmed}” is not a name this can be added under.`
  }
  if (reservedIds.some((reserved) => reserved.toLowerCase() === trimmed.toLowerCase())) {
    return `That marketplace calls itself “${trimmed}”, which is one BuildEx already ships.`
  }
  return null
}

/** Why a marketplace cannot be added, or null when it can. */
export function companyMarketplaceProblem(
  candidate: { id: string; label: string; repo: string },
  reservedIds: readonly string[]
): string | null {
  return marketplaceIdProblem(candidate.id, reservedIds) ?? marketplaceSourceProblem(candidate)
}

function parseEntry(value: unknown): CompanyMarketplace | null {
  if (!isRecord(value)) {
    return null
  }
  const id = asString(value.id)
  const repo = asString(value.repo)
  if (!id || !ID_RE.test(id) || !repo) {
    return null
  }
  const segment = value.defaultSegment
  return {
    id,
    // A hand-written entry may name only the repo; the id is a better fallback
    // than a blank card header.
    label: asString(value.label) ?? id,
    repo,
    defaultSegment: segment === 'software' ? 'software' : 'business'
  }
}

/** Parse a marketplace list body. A malformed row is skipped, not fatal. */
export function parseCompanyMarketplaces(
  json: string,
  displayPath: string
): CompanyMarketplaceList {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    // Why: a file somebody hand-edited into invalid JSON must not empty the
    // Store — the bundled marketplaces still have to draw a shelf.
    return { entries: [], path: displayPath }
  }
  const rows =
    isRecord(raw) && Array.isArray(raw.marketplaces)
      ? raw.marketplaces
      : Array.isArray(raw)
        ? raw
        : []
  const entries = new Map<string, CompanyMarketplace>()
  for (const row of rows) {
    const entry = parseEntry(row)
    if (entry) {
      entries.set(entry.id, entry)
    }
  }
  return { entries: [...entries.values()], path: displayPath }
}

/** The marketplaces a brain holds, or an empty list when it has none yet. */
export function readCompanyMarketplaces(location: BrainLocation): CompanyMarketplaceList {
  const displayPath = companyMarketplacesDisplayPath(location)
  try {
    return parseCompanyMarketplaces(
      readFileSync(companyMarketplacesPath(location), 'utf8'),
      displayPath
    )
  } catch {
    return { entries: [], path: displayPath }
  }
}

function serialize(entries: readonly CompanyMarketplace[]): string {
  // Sorted, like the roster, so two people adding marketplaces in different
  // orders do not produce a spurious diff for each other to resolve.
  const sorted = [...entries].sort((a, b) => a.id.localeCompare(b.id))
  return `${JSON.stringify({ marketplaces: sorted }, null, 2)}\n`
}

function write(location: BrainLocation, entries: readonly CompanyMarketplace[]): void {
  const target = companyMarketplacesPath(location)
  if (entries.length === 0) {
    // An empty list is no list: leaving `{"marketplaces": []}` behind would show
    // a teammate a file that says nothing.
    try {
      rmSync(target, { force: true })
    } catch {
      // A file we cannot remove is stale, not harmful — it parses as empty.
    }
    return
  }
  mkdirSync(path.dirname(target), { recursive: true })
  const next = serialize(entries)
  if (!existsSync(target) || readFileSync(target, 'utf8') !== next) {
    writeFileSync(target, next, 'utf8')
  }
}

/**
 * Add a marketplace, or replace the one already under that id.
 *
 * Replacing rather than rejecting a duplicate: re-adding under the same id is
 * how an operator corrects a repo they mistyped, and the id is the thing that
 * has to stay put — it is the key the agent records installs under.
 */
export function addCompanyMarketplace(
  location: BrainLocation,
  marketplace: CompanyMarketplace
): CompanyMarketplaceList {
  const current = readCompanyMarketplaces(location)
  const entry: CompanyMarketplace = {
    id: marketplace.id.trim(),
    label: marketplace.label.trim(),
    repo: marketplace.repo.trim(),
    defaultSegment: marketplace.defaultSegment
  }
  const kept = current.entries.filter((candidate) => candidate.id !== entry.id)
  kept.push(entry)
  write(location, kept)
  return {
    entries: parseCompanyMarketplaces(serialize(kept), current.path).entries,
    path: current.path
  }
}

/** Take a marketplace off the list. Removing one that is not there is not an error. */
export function removeCompanyMarketplace(
  location: BrainLocation,
  id: string
): CompanyMarketplaceList {
  const current = readCompanyMarketplaces(location)
  const kept = current.entries.filter((candidate) => candidate.id !== id.trim())
  write(location, kept)
  return { entries: kept, path: current.path }
}
