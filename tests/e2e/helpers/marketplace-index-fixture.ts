import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// Marketplace indexes for the e2e Store, seeded into the fixture's userData.
//
// The app fetches indexes at runtime and caches them, so without this the Store
// would either be empty or reach the network mid-test. Seeding the cache gives a
// deterministic shelf and keeps the suite offline — which also means these
// assertions do not break the day upstream re-categorises something.
//
// Deliberately small. The real index has 276 entries; what the tests need is one
// curated app per marketplace and enough uncurated ones to prove the long tail.

function plugin(
  name: string,
  description: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return { name, description, source: `./plugins/${name}`, ...extra }
}

const INDEXES: Record<string, unknown> = {
  'buildex-packs': {
    name: 'buildex-packs',
    owner: { name: 'BuildEx' },
    plugins: [
      plugin('stripe', 'Payments & subscriptions, from the agent.', { displayName: 'Stripe' }),
      plugin('linear', 'Issues & roadmap, from the agent.', { displayName: 'Linear' }),
      plugin('hubspot', 'CRM — contacts, companies and deals.', { displayName: 'HubSpot' })
    ]
  },
  protocol: {
    name: 'protocol',
    owner: { name: 'Protocol' },
    plugins: [plugin('protocol-crm', 'Coaching CRM, drivable by the agent.')]
  },
  'claude-plugins-official': {
    name: 'claude-plugins-official',
    owner: { name: 'Anthropic' },
    plugins: [
      plugin('clickhouse', 'Connect Claude to your ClickHouse Cloud databases.', {
        category: 'database',
        author: { name: 'ClickHouse' }
      }),
      plugin('clickhouse-best-practices', '28 best practice rules for ClickHouse.', {
        category: 'database',
        author: { name: 'ClickHouse Inc' }
      }),
      // Upstream's stripe is the developer's, and shares a name with ours on
      // purpose — the two-shelves test turns on exactly that.
      plugin('stripe', 'Stripe development plugin for Claude.', {
        category: 'development',
        author: { name: 'Stripe' }
      }),
      plugin('notion', 'Docs & databases — search, read and create pages.', {
        category: 'productivity',
        author: { name: 'Notion' }
      }),
      plugin('github', 'GitHub integration for pull requests and issues.', {
        category: 'productivity'
      })
    ]
  }
}

/** Write the indexes where the app reads its cache from. */
export function seedMarketplaceIndexCache(userDataDir: string, now = Date.now()): void {
  const cacheDir = path.join(userDataDir, 'marketplace-index')
  mkdirSync(cacheDir, { recursive: true })
  for (const [id, index] of Object.entries(INDEXES)) {
    writeFileSync(
      path.join(cacheDir, `${id}.json`),
      // A fresh stamp, so the Store reads the cache as current and never fetches.
      JSON.stringify({ fetchedAt: now, body: JSON.stringify(index) }),
      'utf8'
    )
  }
}
