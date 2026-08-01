import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrainResolution, BrainScan } from '../../shared/buildex-brain-types'
import { EMPTY_BRAIN_SCAN } from '../../shared/buildex-brain-types'
import { DESCRIPTION_LIMIT } from './brain-document-frontmatter'
import { renderCompanyContext, syncCompanyContext } from './company-context'
import { scanCompanyBrain } from './company-brain-service'
import { embeddedLocation } from './brain-location'

// Every case here shells out to real `git`, repeatedly. Vitest's 5s default is a
// budget for pure functions, and under full-suite load these are the files that
// turn a loaded box into a red suite — the noise that hides a real regression.
vi.setConfig({ testTimeout: 60_000 })

let repo = ''

/**
 * The stated ceiling. Five hundred documents arranged as a real company arranges
 * them — 120 clients with four files each, plus twenty decisions — must render
 * in under this many lines. It is a ceiling on the *shape*: one line per entity,
 * one per folder of documents, three trailing lists of ten. Raising it means the
 * map grew a term that scales with the brain, which is the one thing it must not
 * do.
 */
const CONTEXT_MAP_LINE_CEILING = 200

/**
 * The same ceiling in the unit that is actually spent. Lines are the growth law;
 * characters are the bill.
 *
 * This one is enforced in the renderer — `MAP_CHARACTER_CEILING` — and it has to
 * be, which is what the comment that used to sit here got wrong. The per-line
 * budgets bound a line; the tree has a term per entity and a term per folder and
 * nothing bounded their number, so the renderer measures the result and gives up
 * descriptions, then enumeration, to stay under. The fixture below is the shape
 * that used to blow it: 26 524 characters against 20 000, at 520 documents.
 */
const CONTEXT_MAP_CHARACTER_CEILING = 20_000

/** The scaffold's ten sections, which a company that took the offer all have. */
const SCAFFOLD_SECTIONS = [
  'inbox',
  'strategy',
  'decisions',
  'rules',
  'clients',
  'product',
  'people',
  'finance',
  'content',
  'reviews'
]

// Brain documents live under `.buildex/`; the generated outputs do not, so they
// are written and read with explicit paths below.
function write(relativePath: string, contents: string): void {
  const absolute = path.join(repo, '.buildex', relativePath)
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, contents, 'utf8')
}

function writeRaw(relativePath: string, contents: string): void {
  const absolute = path.join(repo, relativePath)
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, contents, 'utf8')
}

function read(relativePath: string): string {
  return readFileSync(path.join(repo, relativePath), 'utf8')
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'buildex-context-'))
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

async function scan(): Promise<BrainScan> {
  const location = embeddedLocation(repo)
  const resolution: BrainResolution = { status: 'ready', location }
  return scanCompanyBrain(repo, location, resolution, 1)
}

describe('renderCompanyContext', () => {
  it('is byte-identical for an unchanged brain', async () => {
    write('a.md', '[[b]]')
    write('b.md', '# B')

    const first = renderCompanyContext(await scan(), [], embeddedLocation(repo))
    const second = renderCompanyContext(await scan(), [], embeddedLocation(repo))

    expect(second).toBe(first)
  })

  it('lists documents by folder and ranks the most connected', async () => {
    write('hub.md', '[[a]] [[b]]')
    write('a.md', '[[hub]]')
    write('b.md', '# B')
    write('notes/side.md', '# Side')

    const rendered = renderCompanyContext(await scan(), [], embeddedLocation(repo))

    expect(rendered).toContain('**root** — a, b, hub')
    expect(rendered).toContain('**notes** — side')
    expect(rendered.indexOf('`hub.md`')).toBeLessThan(rendered.indexOf('`a.md`'))
  })

  it('titles a document by its heading, and falls back to the filename', async () => {
    // At size this is the difference between a readable decisions folder and a
    // wall of `2026-01-14-deprecate-the-v1-api-with-a-twelve-month-window`.
    write(
      'decisions/2026-01-14-deprecate-the-v1-api.md',
      '# Deprecate the v1 API\n\nWith notice.\n'
    )
    write('decisions/untitled.md', 'No heading in this one.\n')

    const scanned = await scan()

    expect(scanned.documents.find((entry) => entry.name.startsWith('2026-01-14'))?.title).toBe(
      'Deprecate the v1 API'
    )
    expect(scanned.documents.find((entry) => entry.name === 'untitled')?.title).toBe('untitled')
  })

  it('names an entity and its summary instead of listing what is inside it', async () => {
    write('clients/acme/index.md', '# Acme Corp\n\nRenewal is Q3.\n')
    write('clients/acme/pricing.md', '# Pricing')
    write('clients/acme/calls/2026-03-11.md', '# Call')

    const rendered = renderCompanyContext(await scan(), [], embeddedLocation(repo))

    expect(rendered).toContain('**Acme Corp** `clients/acme/` — Renewal is Q3.')
    expect(rendered).not.toContain('pricing')
    expect(rendered).not.toContain('2026-03-11')
  })

  it('spends exactly one line per entity, however many there are', async () => {
    // The one job entity detection has. The Brain used to build a whole parallel
    // taxonomy on it — a page, a card, its own Add branch — and all of that is
    // gone; this is what had to survive it, so it is asserted against the count
    // rather than against a fixture that happens to be right.
    const entityLine = /^ *- \*\*Client \d+\*\* `clients\/client-\d+\/`/
    const linesFor = async (count: number): Promise<string[]> => {
      for (let index = 0; index < count; index += 1) {
        write(`clients/client-${index}/index.md`, `# Client ${index}\n\nRenewal is Q3.\n`)
        write(`clients/client-${index}/notes.md`, '# Notes\n')
        write(`clients/client-${index}/calls/first.md`, '# Call\n')
      }
      const rendered = renderCompanyContext(await scan(), [], embeddedLocation(repo))
      return rendered.split('\n').filter((line) => entityLine.test(line))
    }

    expect(await linesFor(3)).toHaveLength(3)
    // Doubling the company doubles the lines and nothing else: the three files
    // inside each client still cost nothing.
    expect(await linesFor(6)).toHaveLength(6)
    expect((await linesFor(6))[0]).toBe('  - **Client 0** `clients/client-0/` — Renewal is Q3.')
  })

  it('renders a description beside the filename, and nothing extra without one', async () => {
    write('decisions/pricing.md', '---\ndescription: Why we price per seat.\n---\n\n# Pricing\n')
    write('decisions/plain.md', '# Plain\n')

    const rendered = renderCompanyContext(await scan(), [], embeddedLocation(repo))

    expect(rendered).toContain('- **decisions** — plain, pricing (Why we price per seat.)')
  })

  it('leaves a brain with no front matter rendering exactly as it did', async () => {
    // The regression that would silently degrade every brain written so far.
    write('rules/operating.md', '# Operating\n\nRules.\n')
    write('notes/side.md', '# Side\n')

    const rendered = renderCompanyContext(await scan(), [], embeddedLocation(repo))

    expect(rendered).toContain('- **rules** — operating')
    expect(rendered).toContain('- **notes** — side')
    // No document carries the parenthesis a description would have added.
    expect(
      rendered.split('\n').filter((line) => line.startsWith('- **') && line.includes('('))
    ).toEqual([])
  })

  it('costs one document exactly one changed line when it gains a description', async () => {
    write('rules/operating.md', '# Operating\n')
    write('notes/side.md', '# Side\n')
    const before = renderCompanyContext(await scan(), [], embeddedLocation(repo)).split('\n')

    write('notes/side.md', '---\ndescription: Odds and ends.\n---\n\n# Side\n')
    const after = renderCompanyContext(await scan(), [], embeddedLocation(repo)).split('\n')

    expect(after).toHaveLength(before.length)
    expect(after.filter((line, index) => line !== before[index])).toEqual([
      '- **notes** — side (Odds and ends.)'
    ])
  })

  it('stays bounded as clients multiply: one line each, not one per file', async () => {
    // The shape this replaced emitted a bullet per folder path, so every client
    // added three or four lines of near-identical noise to every agent prompt.
    const addClients = (from: number, to: number): void => {
      for (let index = from; index < to; index += 1) {
        write(`clients/client-${index}/index.md`, `# Client ${index}\n\nA summary.\n`)
        write(`clients/client-${index}/notes.md`, '# Notes')
        write(`clients/client-${index}/calls/first.md`, '# Call')
      }
    }
    const clientLines = (rendered: string): number =>
      rendered.split('\n').filter((line) => line.includes('clients/client-')).length

    addClients(0, 2)
    const two = renderCompanyContext(await scan(), [], embeddedLocation(repo))
    addClients(2, 6)
    const six = renderCompanyContext(await scan(), [], embeddedLocation(repo))

    expect(clientLines(two)).toBe(2)
    expect(clientLines(six)).toBe(6)
  })

  it('holds both ceilings at a thousand documents, every description at its limit', async () => {
    // The map is read in full at the start of every agent session, so its size
    // is the product's budget, not a detail. The growth law it has to keep: one
    // line per entity and one per folder of documents, never one per file — and
    // a `description:` rides the line its name was already on rather than
    // claiming one of its own.
    //
    // Deliberately adversarial where the first version of this test was polite.
    // Every description is written at `DESCRIPTION_LIMIT`, not at the twenty
    // characters a fixture reaches for by habit; and 500 documents sit in a
    // FLAT section, which `renderTree` folds onto a single line — the shape that
    // passes a line ceiling at one line while blowing a character ceiling
    // fourfold. Entity children never reach that code path at all, so a fixture
    // made only of entities cannot see it.
    const fullLength = `${'situation '.repeat(30)}end`
    expect(fullLength.length).toBeGreaterThan(DESCRIPTION_LIMIT)

    for (let index = 0; index < 120; index += 1) {
      const client = `clients/client-${index}`
      write(`${client}/index.md`, `---\ndescription: ${fullLength}\n---\n\n# Client ${index}\n`)
      write(`${client}/notes.md`, '# Notes\n')
      write(`${client}/calls/first.md`, '# Call\n')
      write(`${client}/calls/second.md`, '# Call\n')
    }
    for (let index = 0; index < 500; index += 1) {
      write(`decisions/decision-${index}.md`, `---\ndescription: ${fullLength}\n---\n\n# D\n`)
    }
    for (let index = 0; index < 20; index += 1) {
      write(`notes/note-${index}.md`, `---\ndescription: ${fullLength}\n---\n\n# N\n`)
    }

    const described = await scan()
    const rendered = renderCompanyContext(described, [], embeddedLocation(repo))

    // Every description reached the map at its full permitted length, so this is
    // the worst case rather than an average one.
    expect(described.documents).toHaveLength(1000)
    expect(
      described.documents.filter((document) => document.description?.endsWith('…'))
    ).toHaveLength(640)

    // 10 declared sections + 1 undeclared (`notes`) + 120 entity lines + 9 of
    // preamble and headings. The 620 documents inside those folders cost zero.
    // The tenth declared section is `inbox`, and it is why this is 140 rather
    // than 139: a section costs one line whether or not it holds anything, so
    // declaring one moves this by exactly one and moves nothing's growth law.
    expect(rendered.split('\n')).toHaveLength(140)
    expect(rendered.split('\n').length).toBeLessThanOrEqual(CONTEXT_MAP_LINE_CEILING)
    expect(rendered.length).toBeLessThanOrEqual(CONTEXT_MAP_CHARACTER_CEILING)

    // And the descriptions are free in lines: strip every one and the map is the
    // same height, which is what "bounded" has to mean here.
    for (let index = 0; index < 120; index += 1) {
      write(`clients/client-${index}/index.md`, `# Client ${index}\n`)
    }
    for (let index = 0; index < 500; index += 1) {
      write(`decisions/decision-${index}.md`, '# D\n')
    }
    for (let index = 0; index < 20; index += 1) {
      write(`notes/note-${index}.md`, '# N\n')
    }

    const bare = renderCompanyContext(await scan(), [], embeddedLocation(repo))

    expect(bare.split('\n')).toHaveLength(rendered.split('\n').length)
  })

  it('holds the character ceiling for a company using the whole scaffold', async () => {
    // The shape the previous fixtures each avoided by growing exactly one term:
    // 120 entities AND every scaffolded section holding described documents.
    // Rendered whole this is 26 524 characters — 33% over. The renderer gives up
    // descriptions before it gives up a path, and says so either way.
    const fullLength = `${'situation '.repeat(30)}end`
    for (let index = 0; index < 120; index += 1) {
      write(
        `clients/client-${index}/index.md`,
        `---\ndescription: ${fullLength}\n---\n\n# Client ${index}\n`
      )
    }
    for (const section of SCAFFOLD_SECTIONS) {
      for (let index = 0; index < 40; index += 1) {
        write(
          `${section}/${section}-${String(index).padStart(2, '0')}.md`,
          `---\ndescription: ${fullLength}\n---\n\n# Doc\n`
        )
      }
    }

    const rendered = renderCompanyContext(await scan(), [], embeddedLocation(repo))

    expect(rendered.length).toBeLessThanOrEqual(CONTEXT_MAP_CHARACTER_CEILING)
    expect(rendered.split('\n').length).toBeLessThanOrEqual(CONTEXT_MAP_LINE_CEILING)
    // Never silently: the agent is told the descriptions it sees are cut short.
    expect(rendered).toContain('to keep this file within its size budget')
    // Narrowed, not abandoned — the drop straight to bare paths would have cost
    // two thirds of what actually fits.
    expect(rendered).toContain('Descriptions below are cut to 40 characters')
    expect(rendered.length).toBeGreaterThan(15_000)
    // And nothing navigable was dropped to get there — every client still opens.
    expect(rendered).toContain('`clients/client-119/`')
    for (const section of SCAFFOLD_SECTIONS) {
      expect(rendered).toContain(`- **${section}**`)
    }
  })

  it('says how much of the map it could not fit when even the paths do not fit', async () => {
    // Past the point where dropping descriptions is enough. A map that just
    // stopped would have the agent believe those folders do not exist.
    for (let index = 0; index < 900; index += 1) {
      write(`clients/client-${String(index).padStart(4, '0')}/index.md`, '# Client\n')
    }

    const rendered = renderCompanyContext(await scan(), [], embeddedLocation(repo))

    expect(rendered.length).toBeLessThanOrEqual(CONTEXT_MAP_CHARACTER_CEILING)
    expect(rendered).toContain('this map reached its size budget')
    expect(rendered).toMatch(/- _\d+ more folders and entities are not listed/)
    // The trailing lists are capped already, so they are not what gave way.
    expect(rendered).toContain('## Documents (900)')
  })

  it('cuts a description harder for the map than for the tree', async () => {
    // 160 is what a Brain row can afford. This file is read in full every
    // session and takes half, so the same document reads longer in the app
    // than it does in the agent's prompt — on purpose.
    const long = `${'situation '.repeat(30)}end`
    write('decisions/pricing.md', `---\ndescription: ${long}\n---\n\n# Pricing\n`)

    const scanned = await scan()
    const rendered = renderCompanyContext(scanned, [], embeddedLocation(repo))
    const line = rendered.split('\n').find((entry) => entry.startsWith('- **decisions**')) ?? ''

    const asData = scanned.documents[0]?.description ?? ''
    expect(asData.length).toBeLessThanOrEqual(DESCRIPTION_LIMIT)
    expect(asData.endsWith('…')).toBe(true)
    // The map's copy is shorter still, and the whole line comes in under what
    // the description alone was allowed as data.
    expect(line.length).toBeLessThan(DESCRIPTION_LIMIT)
    expect(line.endsWith('…)')).toBe(true)
  })

  it('says how many documents a folder line left out rather than cutting silently', async () => {
    // An agent that knows there are more will open the folder; one shown a
    // silently cut list believes it has seen everything there is.
    for (let index = 0; index < 30; index += 1) {
      write(`decisions/decision-${String(index).padStart(2, '0')}.md`, '# D\n')
    }

    const rendered = renderCompanyContext(await scan(), [], embeddedLocation(repo))
    const line = rendered.split('\n').find((entry) => entry.startsWith('- **decisions**')) ?? ''

    expect(line).toContain('+18 more')
    expect(line).toContain('decision-18, decision-19')
    expect(line).not.toContain('decision-00')
  })

  it('shows the newest of a dated stream, not the twelve the operator moved past', async () => {
    // WP-14b's capture stream is `inbox/<date>.md`, and a folder's documents
    // arrive sorted ascending by id — so the first twelve of a dated folder are
    // the oldest twelve. For a stream whose whole value is recency that is
    // backwards, and it is the same for dated `decisions/` slugs.
    for (let day = 1; day <= 20; day += 1) {
      write(`inbox/2026-03-${String(day).padStart(2, '0')}.md`, '# Capture\n')
    }

    const rendered = renderCompanyContext(await scan(), [], embeddedLocation(repo))
    const line = rendered.split('\n').find((entry) => entry.startsWith('- **inbox**')) ?? ''

    expect(line).toContain('2026-03-20')
    expect(line).toContain('2026-03-09')
    expect(line).not.toContain('2026-03-01')
    expect(line).toContain('+8 more')
  })
})

describe('renderCompanyContext archive de-emphasis', () => {
  it('names an archive by path and count, and lists nothing inside it', async () => {
    write('clients/acme.md', '# Acme\n')
    write('clients/archive/dead-co.md', '# Dead Co\n\nChurned in 2025.\n')
    write('clients/archive/gone-ltd.md', '# Gone Ltd\n')

    const scanned = await scan()
    const rendered = renderCompanyContext(scanned, [], embeddedLocation(repo))

    // Present in the repo and in the scan — nothing is hidden from an agent
    // that opens the folder, and nothing was deleted to make the map smaller.
    expect(scanned.documents.map((document) => document.id)).toContain('clients/archive/dead-co.md')
    // De-emphasised in the map: the path and how much is there, no names.
    expect(rendered).toContain(
      '- **clients/archive** — 2 superseded documents, kept for history and not listed here.'
    )
    expect(rendered).not.toContain('dead-co')
    expect(rendered).not.toContain('gone-ltd')
    expect(rendered).toContain('- **clients** — acme')
  })

  it('strictly reduces the map, measured against the same folder not archived', async () => {
    // Identical content either side of the convention, so the difference is the
    // convention rather than the fixture.
    const long = `${'situation '.repeat(30)}end`
    for (let index = 0; index < 20; index += 1) {
      write(`clients/archive/dead-${index}.md`, `---\ndescription: ${long}\n---\n\n# Dead\n`)
      write(`clients/live/open-${index}.md`, `---\ndescription: ${long}\n---\n\n# Open\n`)
    }

    const rendered = renderCompanyContext(await scan(), [], embeddedLocation(repo))
    const lineFor = (folder: string): string =>
      rendered.split('\n').find((line) => line.includes(`**${folder}**`)) ?? ''

    expect(lineFor('clients/live')).toContain('+8 more')
    expect(lineFor('clients/archive')).toContain('20 superseded documents')
    expect(lineFor('clients/archive').length).toBeLessThan(lineFor('clients/live').length / 5)
  })

  it('costs exactly one line however much history piles up', async () => {
    write('clients/acme.md', '# Acme\n')
    write('clients/archive/dead-0.md', '# Dead\n')
    const few = renderCompanyContext(await scan(), [], embeddedLocation(repo)).split('\n')

    for (let index = 1; index < 400; index += 1) {
      write(`clients/archive/dead-${index}.md`, '# Dead\n')
    }
    const many = renderCompanyContext(await scan(), [], embeddedLocation(repo)).split('\n')

    expect(many).toHaveLength(few.length)
    expect(many.join('\n')).toContain('400 superseded documents')
  })

  it('collapses everything below an archive, not only its top level', async () => {
    write('clients/archive/2024/dead-co/index.md', '# Dead Co\n\nChurned.\n')
    write('clients/archive/2024/dead-co/contract.md', '# Contract\n')
    write('clients/archive/note.md', '# Note\n')

    const rendered = renderCompanyContext(await scan(), [], embeddedLocation(repo))
    const archiveLines = rendered.split('\n').filter((line) => line.includes('archive'))

    expect(archiveLines).toHaveLength(1)
    expect(archiveLines[0]).toContain('3 superseded documents')
    expect(rendered).not.toContain('Dead Co')
    expect(rendered).not.toContain('contract')
  })

  it('treats `Archive/` as the same folder, because on this filesystem it is', async () => {
    // Recorded trap 4b: `Orca` and `orca` share an inode on APFS. A case-exact
    // match would enumerate this folder on macOS and collapse it on Linux —
    // the same commit rendering two ways.
    write('decisions/Archive/old-call.md', '# Old call\n')

    const rendered = renderCompanyContext(await scan(), [], embeddedLocation(repo))

    expect(rendered).toContain('- **decisions/Archive** — 1 superseded document')
    expect(rendered).not.toContain('old-call')
  })

  it('leaves a document merely named `archive` alone', async () => {
    // The convention is a folder. A document called `archive.md` is a document.
    write('notes/archive.md', '# Archive\n')

    const rendered = renderCompanyContext(await scan(), [], embeddedLocation(repo))

    expect(rendered).toContain('- **notes** — archive')
    expect(rendered).not.toContain('superseded')
  })

  it('keeps archived ids out of recency before the cap, not after', () => {
    // Archiving is a git change, so the week a dead client is retired is the
    // week this list would be nothing but the ten documents just declared
    // finished — the loudest possible answer pointing at the wrong place.
    const rendered = renderCompanyContext(
      {
        ...EMPTY_BRAIN_SCAN,
        recentDocumentIds: [
          ...Array.from({ length: 10 }, (_, index) => `clients/archive/dead-${index}.md`),
          'rules/operating.md'
        ]
      },
      [],
      embeddedLocation('/repo')
    )

    expect(rendered).toContain('- `rules/operating.md`')
    expect(rendered).not.toContain('archive')
  })

  it('never lets a superseded document hold a most-connected slot', async () => {
    // A document keeps every backlink it ever earned, so without this the dead
    // engagement outranks the live one that replaced it.
    write('clients/archive/dead.md', '# Dead\n')
    write('a.md', '[[dead]]\n')
    write('b.md', '[[dead]] [[a]]\n')

    const rendered = renderCompanyContext(await scan(), [], embeddedLocation(repo))

    expect(rendered).toContain('## Most connected')
    expect(rendered).toContain('- `a.md`')
    expect(rendered).not.toContain('- `clients/archive/dead.md`')
  })
})

describe('renderCompanyContext recency and wanted pages', () => {
  const location = embeddedLocation('/repo')

  it('lists what changed most recently, in the order git reported it', async () => {
    const rendered = renderCompanyContext(
      {
        ...EMPTY_BRAIN_SCAN,
        recentDocumentIds: ['rules/operating.md', 'decisions/pricing.md']
      },
      [],
      location
    )

    expect(rendered).toContain('## Recently changed')
    expect(rendered.indexOf('`rules/operating.md`')).toBeLessThan(
      rendered.indexOf('`decisions/pricing.md`')
    )
  })

  it('says nothing about recency when there is no history to read', () => {
    // No git, a folder workspace, a brain with nothing saved yet.
    expect(renderCompanyContext(EMPTY_BRAIN_SCAN, [], location)).not.toContain(
      '## Recently changed'
    )
  })

  it('caps recency at ten however much has changed', () => {
    const rendered = renderCompanyContext(
      {
        ...EMPTY_BRAIN_SCAN,
        recentDocumentIds: Array.from({ length: 40 }, (_, index) => `doc-${index}.md`)
      },
      [],
      location
    )

    expect(rendered.split('\n').filter((line) => line.startsWith('- `doc-'))).toHaveLength(10)
  })

  it('names wanted pages and who asked for them', () => {
    const rendered = renderCompanyContext(
      {
        ...EMPTY_BRAIN_SCAN,
        wantedPages: [
          {
            name: 'acme-renewal-terms',
            requestedBy: ['clients/acme.md'],
            requestedByCount: 1
          }
        ]
      },
      [],
      location
    )

    expect(rendered).toContain('## Wanted pages')
    expect(rendered).toContain('- `acme-renewal-terms` — wanted by `clients/acme.md`')
  })

  it('keeps one popular gap to one line', () => {
    const rendered = renderCompanyContext(
      {
        ...EMPTY_BRAIN_SCAN,
        wantedPages: [
          {
            name: 'escalation',
            requestedBy: ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'],
            requestedByCount: 5
          }
        ]
      },
      [],
      location
    )

    expect(rendered).toContain('- `escalation` — wanted by `a.md`, `b.md`, `c.md`, +2 more')
  })

  it('caps wanted pages at ten, however many the brain has asked for', () => {
    const rendered = renderCompanyContext(
      {
        ...EMPTY_BRAIN_SCAN,
        wantedPages: Array.from({ length: 50 }, (_, index) => ({
          name: `wanted-${index}`,
          requestedBy: ['a.md'],
          requestedByCount: 1
        }))
      },
      [],
      location
    )

    expect(rendered.split('\n').filter((line) => line.startsWith('- `wanted-'))).toHaveLength(10)
  })
})

describe('syncCompanyContext', () => {
  it('writes the context file and adds the CLAUDE.md import', async () => {
    write('a.md', '# A')

    const result = syncCompanyContext(repo, await scan(), [], embeddedLocation(repo))

    expect(result.contextChanged).toBe(true)
    expect(result.claudeMdChanged).toBe(true)
    expect(read('.claude/company-context.md')).toContain('# Company context')
    expect(read('.claude/CLAUDE.md')).toContain('@./company-context.md')
  })

  it('writes nothing when re-run against the same scan', async () => {
    write('a.md', '# A')
    const snapshot = await scan()
    syncCompanyContext(repo, snapshot, [], embeddedLocation(repo))

    const second = syncCompanyContext(repo, snapshot, [], embeddedLocation(repo))

    expect(second.contextChanged).toBe(false)
    expect(second.claudeMdChanged).toBe(false)
  })

  it('is genuinely idempotent now that nothing it writes is a brain document', async () => {
    write('a.md', '# A')

    // Why: both outputs live under `.claude/`, which the scanner skips and git
    // ignores — so re-syncing writes nothing and shows up in no history.
    syncCompanyContext(repo, await scan(), [], embeddedLocation(repo))
    const second = syncCompanyContext(repo, await scan(), [], embeddedLocation(repo))

    expect(second.contextChanged).toBe(false)
    expect(second.claudeMdChanged).toBe(false)
  })

  it("preserves the operator's own project instructions", async () => {
    writeRaw('.claude/CLAUDE.md', '# House rules\n\nAlways ask before deploying.\n')
    write('a.md', '# A')

    syncCompanyContext(repo, await scan(), [], embeddedLocation(repo))

    const claudeMd = read('.claude/CLAUDE.md')
    expect(claudeMd).toContain('Always ask before deploying.')
    expect(claudeMd).toContain('@./company-context.md')
  })

  it('keeps the generated file out of the company history', async () => {
    // Why: this file is derived from `.buildex/` and regenerated constantly. In
    // the tracked brain folder it produced a diff every time anything changed.
    write('a.md', '# A')

    syncCompanyContext(repo, await scan(), [], embeddedLocation(repo))

    expect(existsSync(path.join(repo, '.buildex', 'company-context.md'))).toBe(false)
    expect(existsSync(path.join(repo, '.claude', 'company-context.md'))).toBe(true)
  })

  it('never touches a company document in the brain folder', async () => {
    // Why: invariant 8. Nothing the operator wrote in `.buildex/` is ours to
    // remove, whatever it is called.
    write('a.md', '# A')
    write('company-context.md', '# Our own notes on context\n')

    syncCompanyContext(repo, await scan(), [], embeddedLocation(repo))

    expect(read('.buildex/company-context.md')).toContain('Our own notes')
  })

  it('repoints an import written by an older BuildEx', async () => {
    // Why: existing repos carry the old path between the markers. Left alone the
    // agent would follow it to a file that no longer exists.
    writeRaw(
      '.claude/CLAUDE.md',
      '<!-- buildex:company-context:begin -->\n@../.buildex/company-context.md\n<!-- buildex:company-context:end -->\n'
    )
    write('a.md', '# A')

    syncCompanyContext(repo, await scan(), [], embeddedLocation(repo))

    const claudeMd = read('.claude/CLAUDE.md')
    expect(claudeMd).toContain('@./company-context.md')
    expect(claudeMd).not.toContain('@../.buildex/company-context.md')
  })

  it('does not duplicate the import block across repeated syncs', async () => {
    writeRaw('.claude/CLAUDE.md', '# Rules\n')
    write('a.md', '# A')

    syncCompanyContext(repo, await scan(), [], embeddedLocation(repo))
    write('b.md', '# B')
    syncCompanyContext(repo, await scan(), [], embeddedLocation(repo))

    const occurrences = read('.claude/CLAUDE.md').split('@./company-context.md').length - 1
    expect(occurrences).toBe(1)
  })
})

describe('renderCompanyContext apps section', () => {
  const scan: BrainScan = { ...EMPTY_BRAIN_SCAN, repoPath: '/repo', scannedAt: 1 }
  const location = embeddedLocation('/repo')

  it('says nothing when no app is installed', () => {
    expect(renderCompanyContext(scan, [], location)).not.toContain('## Apps')
  })

  it('names the skills and tells the agent to read them first', () => {
    const rendered = renderCompanyContext(
      scan,
      [
        {
          id: 'slack',
          name: 'Slack',
          summary: 'Team chat.',
          skills: ['slack-search', 'slack-post'],
          hasMcp: true,
          envKey: 'BUILDEX_SLACK_API_KEY',
          connected: true
        }
      ],
      location
    )

    expect(rendered).toContain('## Apps (1)')
    expect(rendered).toContain('`slack-search`, `slack-post`')
    expect(rendered).toContain('read the skill before improvising')
    expect(rendered).toContain('prefer them over shell or HTTP calls')
  })

  it('names no path for an app, because neither path it used to name is there', () => {
    // A plugin's skills and its MCP server live inside the plugin the agent
    // installed and load from there. `.buildex/skills/` holds the brain's own
    // skills and never an app's; the repo `.mcp.json` this fork used to write is
    // removed on upgrade. Both sent the agent to an empty place.
    const rendered = renderCompanyContext(
      scan,
      [
        {
          id: 'slack',
          name: 'Slack',
          summary: 'Team chat.',
          skills: ['slack-search'],
          hasMcp: true,
          envKey: 'BUILDEX_SLACK_API_KEY',
          connected: true
        }
      ],
      location
    )

    expect(rendered).not.toContain('.buildex/skills/')
    expect(rendered).not.toContain('.mcp.json')
    expect(rendered).not.toContain('.claude/skills/')
    // And the retracted vocabulary with them.
    expect(rendered).not.toContain('capability pack')
  })

  it('bounds the apps section, which no ceiling test used to reach at all', () => {
    // Every ceiling assertion passed `apps: []`, so app count, summary and skill
    // list were the one part of this file nothing measured.
    const apps = Array.from({ length: 40 }, (_, index) => ({
      id: `app-${index}`,
      name: `App ${index}`,
      summary: `${'a very long marketing sentence '.repeat(20)}end`,
      skills: Array.from({ length: 50 }, (_, skill) => `skill-${skill}`),
      hasMcp: true,
      envKey: `APP_${index}_API_KEY`,
      connected: true
    }))

    const rendered = renderCompanyContext(scan, apps, location)

    expect(rendered).toContain('## Apps (40)')
    expect(rendered).toContain('+28 more installed')
    expect(rendered).not.toContain('### App 12')
    expect(rendered).toContain('+38 more')
    expect(rendered).not.toContain('`skill-12`')
    expect(rendered).not.toContain('very long marketing sentence end')
    expect(rendered.length).toBeLessThanOrEqual(CONTEXT_MAP_CHARACTER_CEILING)
  })

  it('flags an app whose key is missing rather than implying it works', () => {
    const rendered = renderCompanyContext(
      scan,
      [
        {
          id: 'stripe',
          name: 'Stripe',
          summary: '',
          skills: ['stripe-lookup'],
          hasMcp: true,
          envKey: 'BUILDEX_STRIPE_API_KEY',
          connected: false
        }
      ],
      location
    )

    expect(rendered).toContain('no key is stored on this machine yet')
  })

  it('tells the agent where the key comes from and never to write it down', () => {
    const rendered = renderCompanyContext(
      scan,
      [
        { id: 'a', name: 'A', summary: '', skills: ['a-skill'], hasMcp: false, envKey: 'A_API_KEY' }
      ],
      location
    )

    expect(rendered).toContain('`A_API_KEY` environment variable')
    expect(rendered).toContain('never write it into the repo')
  })
})

describe('renderCompanyContext brain location', () => {
  it('tells the agent where an external brain is, since ids alone resolve to nothing', () => {
    const scan = {
      ...EMPTY_BRAIN_SCAN,
      documents: [
        {
          id: 'decisions/pricing.md',
          name: 'pricing',
          title: 'Pricing',
          folder: 'decisions',
          linksTo: [],
          linkedFrom: [],
          changed: false,
          headingCount: 1,
          wordCount: 3
        }
      ]
    }

    const rendered = renderCompanyContext(scan, [], {
      root: '/brains/acme',
      gitRoot: '/brains/acme',
      pathspec: '.',
      mode: 'external'
    })

    // Without this line the agent is told about `decisions/pricing.md` and, with
    // its cwd in the code repo, finds nothing there.
    expect(rendered).toContain('/brains/acme')
  })

  it('says nothing about paths when the brain is in the repo', () => {
    const rendered = renderCompanyContext(EMPTY_BRAIN_SCAN, [], {
      root: '/code/api/.buildex',
      gitRoot: '/code/api',
      pathspec: '.buildex',
      mode: 'embedded'
    })

    expect(rendered).toContain('`.buildex/`')
    expect(rendered).not.toContain('/code/api/.buildex')
  })

  it('names no skills directory for an app in either brain mode', () => {
    // Why: the earlier copy chose between `.buildex/skills/` and the external
    // brain's `skills/`, and an app's skills are in neither — they are in the
    // plugin. Being right about which empty directory to name is not a fix.
    const app = { id: 'slack', name: 'Slack', summary: '', skills: ['slack-search'], hasMcp: false }

    const external = renderCompanyContext(EMPTY_BRAIN_SCAN, [app], {
      root: '/brains/acme',
      gitRoot: '/brains/acme',
      pathspec: '.',
      mode: 'external'
    })

    expect(external).not.toContain('Skills live in')
    expect(external).not.toContain('/brains/acme/skills/')
    expect(renderCompanyContext(EMPTY_BRAIN_SCAN, [app], embeddedLocation('/repo'))).not.toContain(
      '.buildex/skills/'
    )
  })
})
