import path from 'node:path'
import type {
  CompanyMarketplace,
  StoreCatalog,
  StoreEntry,
  StoreMarketplace,
  StoreOverlay,
  StoreRequirement,
  StoreRoster,
  StoreSegment
} from '../../shared/buildex-store-types'
import { parseMarketplaceManifest } from './marketplace-manifest'
import { segmentForPlugin } from './store-segments'
import { findOverlay } from './store-overlay'
import { rosterIndex } from './store-roster'

// Assembling the shelf: marketplace indexes, plus the overlays that say what
// BuildEx adds, plus what the agent reports as already installed.
//
// Indexes are fetched and cached rather than bundled. Bundling a copy would put
// 160 kB of guaranteed-stale JSON in the app, and it would buy less than it
// looks: installing shells out to the agent's plugin CLI, which needs the
// network anyway, so an offline shelf is one you can read and not use.
//
// Plugin bytes are never fetched here either — that is the CLI's job, and it is
// the only thing that can install a plugin whole.
//
// Pure: no fs, no electron, no knowledge of where an index came from. The caller
// hands in the bodies, so the same code serves the cache, a test fixture, and
// whatever a company adds later.

export const BUNDLED_OVERLAYS_SUBPATH = path.join('buildex', 'overlays')

export function overlaysRootFrom(resourceRoot: string): string {
  return path.join(resourceRoot, BUNDLED_OVERLAYS_SUBPATH)
}

/**
 * A marketplace the Store reads, and the index body it was last seen with.
 *
 * `id` must be the `name` inside that marketplace.json, because that is the key
 * the agent uses when it records an install — entries read `stripe@claude-plugins-official`.
 * An id invented here would never match, and every plugin would read as
 * not-installed forever.
 */
export type StoreMarketplaceSource = StoreMarketplace & {
  /** The cached marketplace.json, or null when it has never been fetched. */
  indexBody: string | null
}

export type KnownMarketplace = StoreMarketplace

/**
 * The marketplaces the Store knows about.
 *
 * A list rather than a fetch of some registry: these are the three we have a
 * reason to trust by default, and anything else is a company adding one.
 */
export const KNOWN_MARKETPLACES: KnownMarketplace[] = [
  {
    id: 'claude-plugins-official',
    label: 'Claude plugins',
    repo: 'anthropics/claude-plugins-official',
    origin: 'bundled',
    defaultSegment: 'software' as StoreSegment
  },
  {
    id: 'buildex-packs',
    label: 'BuildEx',
    repo: 'dejankeri/buildex-packs',
    origin: 'bundled',
    defaultSegment: 'business' as StoreSegment
  },
  {
    id: 'protocol',
    label: 'Protocol',
    repo: 'dejankeri/protocol-claude-plugin',
    origin: 'bundled',
    defaultSegment: 'business' as StoreSegment
  }
]

/** The ids a company marketplace may not take, because a bundled one holds them. */
export const RESERVED_MARKETPLACE_IDS: readonly string[] = KNOWN_MARKETPLACES.map(
  (marketplace) => marketplace.id
)

/**
 * The bundled marketplaces plus whatever this company added.
 *
 * A company entry whose id collides with a bundled one is dropped rather than
 * allowed to win: the id is the key the agent records installs under, so a
 * shadowed bundled marketplace would report the wrong plugin as installed. The
 * add path rejects the collision up front; this is the guard for a file that was
 * hand-edited or pulled from a teammate.
 */
export function allMarketplaces(company: readonly CompanyMarketplace[]): StoreMarketplace[] {
  const taken = new Set(RESERVED_MARKETPLACE_IDS.map((id) => id.toLowerCase()))
  const added: StoreMarketplace[] = []
  for (const marketplace of company) {
    const key = marketplace.id.toLowerCase()
    if (taken.has(key)) {
      continue
    }
    taken.add(key)
    added.push({ ...marketplace, origin: 'company' })
  }
  return [...KNOWN_MARKETPLACES, ...added]
}

/** How an install is keyed, matching what the agent writes down. */
export function installKey(pluginName: string, marketplaceId: string): string {
  return `${pluginName}@${marketplaceId}`
}

export type StoreCatalogInput = {
  marketplaces: readonly StoreMarketplaceSource[]
  overlays: readonly StoreOverlay[]
  /** Install keys the agent reports, in `plugin@marketplace` form. */
  installed: ReadonlySet<string>
  /** What this company expects installed, from the brain. */
  roster?: StoreRoster | null
  /** Where company marketplaces are written, or null when there is no brain. */
  marketplacesPath?: string | null
  /** Set when the workspace's agent has no plugin system BuildEx can drive. */
  unsupportedAgent?: string | null
}

/** Roster first, then curated, so the shelf opens on what the company runs on. */
const REQUIREMENT_RANK: Record<StoreRequirement, number> = { required: 0, suggested: 1 }

function requirementRank(entry: StoreEntry): number {
  return entry.requirement ? REQUIREMENT_RANK[entry.requirement] : 2
}

function readIndex(source: StoreMarketplaceSource): ReturnType<typeof parseMarketplaceManifest> {
  // A marketplace never fetched, or whose cached body is unusable, contributes
  // nothing. The others still fill the shelf.
  return source.indexBody ? parseMarketplaceManifest(source.indexBody) : null
}

/** Build the shelf. */
export function readStoreCatalog(input: StoreCatalogInput): StoreCatalog {
  const entries: StoreEntry[] = []
  const marketplaces: StoreMarketplace[] = []
  const roster = rosterIndex(input.roster ?? null)

  for (const source of input.marketplaces) {
    const manifest = readIndex(source)
    const { indexBody: _indexBody, ...marketplace } = source
    marketplaces.push(marketplace)
    if (!manifest) {
      continue
    }
    for (const plugin of manifest.plugins) {
      const overlay = findOverlay(input.overlays, plugin.name, source.id)
      const key = installKey(plugin.name, source.id)
      const expected = roster.get(key)
      entries.push({
        // Why: an overlay may name the app properly. A marketplace entry with no
        // displayName falls back to its identifier, which reads as `hubspot`.
        plugin: overlay?.displayName ? { ...plugin, displayName: overlay.displayName } : plugin,
        marketplaceId: source.id,
        marketplaceLabel: source.label,
        segment: segmentForPlugin(plugin, source.defaultSegment, overlay),
        // Curation is what BuildEx has said about a plugin — the gate, the
        // credential, the system-of-record line. Everything else is long tail
        // and is labelled as such.
        curated: Boolean(overlay),
        overlay,
        installed: input.installed.has(key),
        ...(expected
          ? {
              requirement: expected.requirement,
              ...(expected.reason ? { requirementReason: expected.reason } : {})
            }
          : {})
      })
    }
  }

  // What the company expects first, then what BuildEx curated, then by name: a
  // teammate opening the Store after a clone should see this company's apps
  // before the 276 plugins nobody vetted.
  entries.sort(
    (a, b) =>
      requirementRank(a) - requirementRank(b) ||
      Number(b.curated) - Number(a.curated) ||
      a.plugin.displayName.localeCompare(b.plugin.displayName, undefined, {
        sensitivity: 'base'
      }) ||
      a.marketplaceId.localeCompare(b.marketplaceId)
  )

  return {
    entries,
    marketplaces,
    marketplacesPath: input.marketplacesPath ?? null,
    roster: input.roster ?? null,
    // Freshness is a fact about the cache, not about the shelf, so the caller
    // that read the cache fills these in.
    indexFetchedAt: null,
    indexStale: true,
    unsupportedAgent: input.unsupportedAgent ?? null
  }
}
