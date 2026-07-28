import { describe, expect, it } from 'vitest'
import type { TuiAgent } from '../../../../shared/types'
import { MCP_CONNECT_COMMAND, resolveMcpConnectAgent } from './connect-plugin-via-mcp'

describe('resolveMcpConnectAgent', () => {
  it('picks Claude, whose /mcp command this is', () => {
    expect(resolveMcpConnectAgent(['gemini', 'claude'] as TuiAgent[], null)).toBe('claude')
  })

  it('offers nothing when no agent understands the command', () => {
    // Why: typing /mcp at an agent that does not know it opens a terminal and
    // writes nonsense. Better to show the manual hint than a broken button.
    expect(resolveMcpConnectAgent(['gemini'] as TuiAgent[], null)).toBeNull()
    expect(resolveMcpConnectAgent([], null)).toBeNull()
  })

  it('offers nothing before detection has finished', () => {
    expect(resolveMcpConnectAgent(null, 'claude')).toBeNull()
  })

  it('ignores a default agent that cannot run the command', () => {
    expect(resolveMcpConnectAgent(['claude'] as TuiAgent[], 'gemini' as TuiAgent)).toBe('claude')
    expect(resolveMcpConnectAgent(['claude'] as TuiAgent[], 'blank')).toBe('claude')
  })
})

describe('MCP_CONNECT_COMMAND', () => {
  it('is the agent’s own command, not something BuildEx invented', () => {
    expect(MCP_CONNECT_COMMAND).toBe('/mcp')
  })
})
