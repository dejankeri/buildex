import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { PluginCommandResult } from './claude-plugin-install'

// Finding and running the `claude` binary.
//
// Electron's PATH is not the operator's. The app is launched from Finder or a
// dock icon, so it inherits a minimal environment that does not include
// ~/.local/bin — where the installer actually puts `claude`. Resolving by hand
// against the places it is really installed is what makes the Store work for a
// normal desktop launch rather than only when Orca was started from a terminal.

const COMMAND_TIMEOUT_MS = 120_000
/** A marketplace clone can be large; a truncated error message helps nobody. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

function candidatePaths(homeDir: string): string[] {
  return [
    path.join(homeDir, '.local', 'bin', 'claude'),
    path.join(homeDir, '.claude', 'local', 'claude'),
    path.join(homeDir, 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude'
  ]
}

/**
 * Where `claude` is, or null when this machine has no CLI to drive.
 *
 * Null is a first-class answer: the Store still browses without it and says
 * plainly that it cannot install, which is better than an install that fails
 * with a spawn error after the operator has pressed the button.
 */
export function resolveClaudeBinary(
  homeDir: string,
  isWindows: boolean = process.platform === 'win32'
): string | null {
  const suffixes = isWindows ? ['.cmd', '.exe', ''] : ['']
  for (const candidate of candidatePaths(homeDir)) {
    for (const suffix of suffixes) {
      if (existsSync(`${candidate}${suffix}`)) {
        return `${candidate}${suffix}`
      }
    }
  }
  // Last resort: let the OS resolve it, which works when Orca was launched from
  // a shell that already had it on PATH.
  return isWindows ? 'claude.cmd' : 'claude'
}

/** Run one `claude …` command, capturing both streams for the failure case. */
export function runClaudeCommand(binary: string, args: string[]): PluginCommandResult {
  try {
    const output = execFileSync(binary, args, {
      encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      // Why: the CLI writes its real diagnosis to stderr, and that is exactly
      // the text worth showing when an install fails.
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { ok: true, output: output.trim() }
  } catch (error) {
    return { ok: false, output: describeFailure(error) }
  }
}

function describeFailure(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return String(error)
  }
  const failure = error as { code?: unknown; stderr?: unknown; stdout?: unknown; message?: unknown }
  if (failure.code === 'ENOENT') {
    return 'The Claude Code CLI is not installed on this machine.'
  }
  const streams = [failure.stderr, failure.stdout]
    .map((stream) => (typeof stream === 'string' ? stream.trim() : ''))
    .filter(Boolean)
    .join('\n')
  return streams || (typeof failure.message === 'string' ? failure.message : String(error))
}
