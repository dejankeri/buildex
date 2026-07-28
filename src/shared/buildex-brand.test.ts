import { describe, expect, it } from 'vitest'
import { applyBuildExBrand } from './buildex-brand'

describe('applyBuildExBrand', () => {
  it('rebrands prose where Orca means this app', () => {
    expect(applyBuildExBrand('BuildEx applies this networking mode at startup.')).toBe(
      'BuildEx applies this networking mode at startup.'
    )
    expect(applyBuildExBrand('Sign out of BuildEx?')).toBe('Sign out of BuildEx?')
    expect(applyBuildExBrand("BuildEx's browser")).toBe("BuildEx's browser")
  })

  it('keeps Stably products and infrastructure', () => {
    expect(applyBuildExBrand('Orca CLI is not visible on PATH yet')).toBe(
      'Orca CLI is not visible on PATH yet'
    )
    expect(applyBuildExBrand('Orca Cloud sign-in is not configured')).toBe(
      'Orca Cloud sign-in is not configured'
    )
    expect(applyBuildExBrand('Orca Relay is in beta.')).toBe('Orca Relay is in beta.')
  })

  it('never touches lowercase identifiers', () => {
    for (const identifier of [
      'Add an `orca.yaml` file to enable shared setup',
      'Local runtime keys are stored in ~/.orca',
      'Created via `orca worktree create`',
      'Register `orca-ide` in ~/.local/bin inside WSL.',
      'orca://pair?code=...',
      '.orca/issue-command'
    ]) {
      expect(applyBuildExBrand(identifier)).toBe(identifier)
    }
  })

  it('never touches ORCA_ environment variables', () => {
    for (const envVar of [
      '$ORCA_WORKTREE_PATH/.env',
      'Cleaning up $ORCA_WORKSPACE_NAME',
      'ORCA_TELEMETRY_DISABLED=1 is set — creating and sending diagnostic files is disabled.',
      'ORCA_AZURE_DEVOPS_ACCESS_TOKEN'
    ]) {
      expect(applyBuildExBrand(envVar)).toBe(envVar)
    }
  })

  it('rebrands the standalone wordmark', () => {
    expect(applyBuildExBrand('ORCA')).toBe('BUILDEX')
  })

  it('leaves interpolation placeholders intact', () => {
    expect(applyBuildExBrand("{{value0}} isn't added to Orca.")).toBe(
      "{{value0}} isn't added to BuildEx."
    )
  })
})
