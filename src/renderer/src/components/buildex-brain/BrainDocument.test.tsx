// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrainDocument as BrainDocumentNode } from '../../../../shared/buildex-brain-types'
import BrainDocument from './BrainDocument'

// Backlinks. The scan has computed `linkedFrom` since the beginning and no
// screen ever showed it, so a document's own context — who reached for it — was
// the one thing the editor could not tell you about the thing you were editing.

vi.mock('./BrainMarkdownEditor', () => ({
  default: (): null => null
}))

const readFile = vi.fn()

function node(id: string, title: string): BrainDocumentNode {
  return {
    id,
    name: id.split('/').at(-1)?.replace(/\.md$/, '') ?? id,
    title,
    folder: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '',
    linksTo: [],
    linkedFrom: [],
    changed: false,
    headingCount: 1,
    wordCount: 2
  }
}

const file = {
  absolutePath: '/repo/.buildex/rules/operating.md',
  relativePath: 'rules/operating.md',
  title: 'rules / operating',
  documentId: 'rules/operating.md'
}

beforeEach(() => {
  readFile.mockReset().mockResolvedValue({ content: '# Operating\n' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only window.api shim
  ;(window as any).api = { fs: { readFile, writeFile: vi.fn() } }
})

afterEach(() => {
  cleanup()
})

describe('BrainDocument backlinks', () => {
  it('names the documents linking here and opens one on click', async () => {
    const onOpenDocument = vi.fn()
    render(
      <BrainDocument
        file={file}
        backlinks={[node('knowledge/method.md', 'How we work')]}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onOpenDocument={onOpenDocument}
      />
    )

    await waitFor(() => expect(screen.getByText(/linked from/i)).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'How we work' }))

    expect(onOpenDocument).toHaveBeenCalledWith('knowledge/method.md')
  })

  it('says nothing at all when nothing links here', async () => {
    render(<BrainDocument file={file} onClose={vi.fn()} onSaved={vi.fn()} />)

    await waitFor(() => expect(readFile).toHaveBeenCalled())
    expect(screen.queryByText(/linked from/i)).not.toBeInTheDocument()
  })
})
