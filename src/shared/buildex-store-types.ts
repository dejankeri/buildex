// The Store's unit of installation is a marketplace plugin, not a pack BuildEx
// authors. Every agent worth supporting now ships a plugin system with its own
// marketplaces, so the Store reads those indexes and delegates installing to the
// agent — which is the only thing that can install a plugin whole, commands and
// hooks and subagents included.
//
// What BuildEx still owns lives in an overlay keyed by plugin name: the
// ask-first gate, the credential the MCP server needs, and the line that tells
// the agent this app is a system of record. A plugin with no overlay installs
// fine; it simply runs ungated and says nothing about itself to the brain.

/**
 * Which shelf a plugin belongs on. The two are different products for different
 * people — `stripe-lookup` for an operator checking an invoice, `stripe-docs`
 * for a developer integrating the API — so one app may appear on both.
 */
export type StoreSegment = 'business' | 'software'

/**
 * Where a plugin's bytes come from. Upstream spells this four ways and every one
 * resolves to git plus a pin, except a bare relative path which means a
 * subdirectory of the marketplace repo itself.
 *
 * BuildEx never fetches these — the agent's own plugin CLI does. They are kept
 * because provenance is the only trust signal an unvetted plugin carries.
 */
export type StorePluginSource =
  | { kind: 'git'; url: string; path?: string; ref?: string; sha?: string }
  | { kind: 'marketplace-relative'; path: string }

export type StorePlugin = {
  /** Unique within its marketplace; the id the agent's CLI installs by. */
  name: string
  displayName: string
  description: string
  /** Upstream's own category, kept verbatim. Segment is derived from it. */
  category: string | null
  author: string | null
  homepage: string | null
  keywords: string[]
  source: StorePluginSource
}

/** A parsed marketplace.json. */
export type StoreMarketplaceManifest = {
  name: string
  owner: string | null
  plugins: StorePlugin[]
}

/** A marketplace the Store reads, and where its index came from. */
export type StoreMarketplace = {
  id: string
  label: string
  /** `owner/repo`, which is also what the agent's CLI adds a marketplace by. */
  repo: string
  /**
   * `bundled` ships with the app, `company` was added by the operator. A bundled
   * marketplace cannot be removed from the Store, a company one can.
   */
  origin: 'bundled' | 'company'
  /** Segment every plugin from this marketplace defaults to. */
  defaultSegment: StoreSegment
}

/**
 * What BuildEx adds to a plugin the marketplace does not carry. Keyed by plugin
 * name so it survives the plugin being updated, moved, or re-pinned upstream.
 */
export type StoreOverlay = {
  pluginName: string
  /** Restricts the overlay to one marketplace when a name appears in several. */
  marketplaceId?: string
  segment?: StoreSegment
  icon?: string
  /**
   * What the app is called on the card.
   *
   * A marketplace entry is not obliged to carry a displayName, and its `name` is
   * an identifier — showing `hubspot` or `protocol-crm` to an operator is the
   * wrong register for a shelf of business apps.
   */
  displayName?: string
  /** Replaces the marketplace's description when BuildEx says it better. */
  summary?: string
  /** Told to the agent as company context: this app is where the truth lives. */
  systemOfRecord?: string
  /**
   * True when the plugin ships an MCP server of its own.
   *
   * Stated rather than inferred: it decides whether connecting is even a thing
   * the operator can do, and it has to be answerable before the plugin is
   * installed — at which point there is nothing on disk to look at.
   */
  mcp?: boolean
  apiKey?: StoreApiKey
  provision?: StoreProvision
  /** Tool calls that wait for a person, in the agent's own permission grammar. */
  gate?: StoreGateRules
}

export type StoreGateRules = {
  ask?: string[]
  deny?: string[]
}

/**
 * How a plugin's MCP server authenticates. `mcp-bearer` means the plugin's own
 * `.mcp.json` references an environment variable BuildEx fills in at terminal
 * launch; `rest` means the plugin's skills call an API with the same variable.
 */
export type StoreApiKey = {
  transport: 'mcp-bearer' | 'rest'
  apiBase?: string
  docsUrl?: string
  /** What to look for, shown verbatim (e.g. "Agent key (pk_…)"). */
  hint?: string
  /** The variable the agent's environment carries. Derived when absent. */
  envKey?: string
}

/** A browser round-trip that mints a key, so nobody pastes one by hand. */
export type StoreProvision = {
  authorizeUrl: string
  exchangeUrl: string
  codeParam: string
  codeField: string
  hostField?: string
  keyPath: string
  apiBasePath?: string
  envKey?: string
  envBase?: string
  /** Said plainly before the operator authorizes, because it is broad. */
  grants?: string
  docsUrl?: string
}

/**
 * How strongly the company expects an app to be installed.
 *
 * This is the one part of an install that IS shared. The plugins themselves are
 * per-operator — each person installs what they need, on the machine they need
 * it on — but which apps a company runs on is a fact about the company, so it
 * lives in the brain and travels with a clone.
 */
export type StoreRequirement = 'required' | 'suggested'

/** One line of the roster: an app, and why the company expects it. */
export type StoreRosterEntry = {
  pluginName: string
  marketplaceId: string
  requirement: StoreRequirement
  /** Said in the operator's words, shown next to the app. */
  reason?: string
}

/** The company's app roster, as read from the brain. */
export type StoreRoster = {
  entries: StoreRosterEntry[]
  /** Repo-relative POSIX path of the file, for the "commit this" hint. */
  path: string
}

export type StoreRosterSetRequest = {
  repoPath: string
  pluginName: string
  marketplaceId: string
  /** Null takes the app off the roster. */
  requirement: StoreRequirement | null
  reason?: string
}

export type StoreRosterResult = {
  ok: boolean
  roster: StoreRoster | null
  error?: string
}

/** A plugin as the Store shows it: marketplace entry plus overlay plus state. */
export type StoreEntry = {
  plugin: StorePlugin
  marketplaceId: string
  marketplaceLabel: string
  segment: StoreSegment
  /** True when BuildEx has an overlay for this plugin — the gate, auth, context. */
  curated: boolean
  overlay: StoreOverlay | null
  installed: boolean
  /** Set when the company's roster names this app. */
  requirement?: StoreRequirement
  /** Why the company expects it, from the roster. */
  requirementReason?: string
  /** True when this machine holds a key for it. Filled at the IPC boundary. */
  credentialConnected?: boolean
}

export type StoreCatalog = {
  entries: StoreEntry[]
  marketplaces: StoreMarketplace[]
  /** The company's roster, or null when this repo has no brain to read one from. */
  roster: StoreRoster | null
  /**
   * When the marketplace indexes were last fetched, or null if never.
   *
   * Indexes are fetched and cached rather than bundled, so null means the Store
   * has nothing to show yet and should go and get it — not that the product has
   * nothing to offer.
   */
  indexFetchedAt: number | null
  /** True when the cache is old enough to be worth refreshing in the background. */
  indexStale: boolean
  /**
   * Set when the agent running this workspace has no plugin system BuildEx can
   * drive, so the Store can say why nothing installs instead of failing later.
   */
  unsupportedAgent: string | null
}

export const EMPTY_STORE_CATALOG: StoreCatalog = {
  entries: [],
  marketplaces: [],
  roster: null,
  indexFetchedAt: null,
  indexStale: true,
  unsupportedAgent: null
}

export type StoreRefreshResult = {
  catalog: StoreCatalog
  /** One line per marketplace that could not be refreshed. */
  errors: string[]
}

export type StoreCatalogRequest = {
  repoPath: string
  /** Agent the workspace runs; decides which marketplaces and which installer. */
  agent?: string
}

export type StoreInstallRequest = {
  repoPath: string
  marketplaceId: string
  pluginName: string
  agent?: string
}

export type StoreInstallResult = {
  ok: boolean
  /** What the agent's CLI said, kept for the failure case. */
  output?: string
  error?: string
}

/** Whether this machine holds a key for a plugin. The key never leaves main. */
export type StoreCredentialStatus = {
  pluginName: string
  connected: boolean
  envKey: string
}

export type StoreCredentialSaveRequest = {
  pluginName: string
  apiKey: string
}

export type StoreCredentialClearRequest = {
  pluginName: string
}

export type StoreCredentialResult = {
  ok: boolean
  status: StoreCredentialStatus | null
  error?: string
}
