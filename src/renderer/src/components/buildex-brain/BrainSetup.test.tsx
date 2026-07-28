// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrainSectionInfo } from '../../../../shared/buildex-brain-types'
import BrainSetup, { type BrainPlacementChoice } from './BrainSetup'

// The one outcome this must never let through silently: the operator picks
// "in a separate brain repo" and, because the connect failed, ends up with an
// embedded brain and no idea why. `onSetUp` rejecting is how `use-brain.ts`
// reports that failure; this covers that the screen actually shows it rather
// than swallowing it.

const sections: BrainSectionInfo[] = [
  { folder: 'strategy', title: 'Strategy', purpose: 'What this company is for.' }
]

function findByLabel(host: HTMLElement, text: string): HTMLElement {
  const element = Array.from(host.querySelectorAll('button, label')).find((entry) =>
    entry.textContent?.includes(text)
  )
  if (!element) {
    throw new Error(`Element not found: ${text}`)
  }
  return element as HTMLElement
}

// A controlled input's value has to go through the native setter React itself
// tracks — assigning `.value` directly leaves React's change detection unaware
// and the onChange handler never fires.
function changeInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('BrainSetup', () => {
  let root: Root | null = null
  let host: HTMLDivElement | null = null

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
      root = null
    }
    host?.remove()
    host = null
  })

  function renderSetup(
    onSetUp: (folders: string[], summary: string, placement: BrainPlacementChoice) => Promise<void>
  ): HTMLDivElement {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => {
      root?.render(<BrainSetup sections={sections} onSetUp={onSetUp} />)
    })
    return host
  }

  it('sends an embedded placement by default', async () => {
    const onSetUp = vi.fn().mockResolvedValue(undefined)
    const container = renderSetup(onSetUp)

    await act(async () => {
      findByLabel(container, 'Create the brain').click()
      await Promise.resolve()
    })

    expect(onSetUp).toHaveBeenCalledWith(['strategy'], '', { mode: 'embedded' })
  })

  it('sends the external placement the operator filled in', async () => {
    const onSetUp = vi.fn().mockResolvedValue(undefined)
    const container = renderSetup(onSetUp)

    act(() => {
      findByLabel(container, 'In a separate brain repo').click()
    })
    act(() => {
      changeInputValue(
        container.querySelector('#brain-setup-external-path') as HTMLInputElement,
        '/home/dev/.buildex/brains/acme'
      )
      changeInputValue(
        container.querySelector('#brain-setup-external-remote') as HTMLInputElement,
        'git@github.com:acme/brain.git'
      )
    })

    await act(async () => {
      findByLabel(container, 'Create the brain').click()
      await Promise.resolve()
    })

    expect(onSetUp).toHaveBeenCalledWith(['strategy'], '', {
      mode: 'external',
      brainPath: '/home/dev/.buildex/brains/acme',
      remote: 'git@github.com:acme/brain.git',
      writePointer: true
    })
  })

  it('shows the error rather than pretending external setup succeeded', async () => {
    const onSetUp = vi.fn().mockRejectedValue(new Error('acme/brain.git is not reachable'))
    const container = renderSetup(onSetUp)

    act(() => {
      findByLabel(container, 'In a separate brain repo').click()
    })
    act(() => {
      changeInputValue(
        container.querySelector('#brain-setup-external-path') as HTMLInputElement,
        '/home/dev/.buildex/brains/acme'
      )
      changeInputValue(
        container.querySelector('#brain-setup-external-remote') as HTMLInputElement,
        'git@github.com:acme/brain.git'
      )
    })

    await act(async () => {
      findByLabel(container, 'Create the brain').click()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('acme/brain.git is not reachable')
  })
})
