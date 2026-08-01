import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getCanonicalUserDataPath } from '../persistence'

// Which brain each repo uses on this machine.
//
// Machine-local by nature: it holds absolute paths, and a path is only true on
// the machine that has the files. The portable half of the choice is the pointer
// in the repo (see brain-location.ts), which names a remote instead.

export type BrainBindings = {
  /** Remote URL -> where it is cloned here. */
  clonesByRemote: Record<string, string>
  /** Repo path -> brain path, for repos bound without writing to the repo. */
  brainByRepo: Record<string, string>
}

export function brainBindingsFile(): string {
  return path.join(getCanonicalUserDataPath(), 'buildex-brains.json')
}

function empty(): BrainBindings {
  return { clonesByRemote: {}, brainByRepo: {} }
}

function isRecordOfStrings(value: unknown): value is Record<string, string> {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every((entry) => typeof entry === 'string')
  )
}

/**
 * A machine with no reachable bindings file has no bindings — that is a correct
 * answer, not an error. Resolving the default path lives inside the try/catch
 * (rather than as a default parameter) because `brainBindingsFile()` itself can
 * throw outside Electron, and a caller running under plain Node deserves the
 * empty store back, not a crash.
 */
export function readBrainBindings(file?: string): BrainBindings {
  try {
    const resolved = file ?? brainBindingsFile()
    const raw: unknown = JSON.parse(readFileSync(resolved, 'utf8'))
    if (!raw || typeof raw !== 'object') {
      return empty()
    }
    const record = raw as Record<string, unknown>
    return {
      clonesByRemote: isRecordOfStrings(record.clonesByRemote) ? record.clonesByRemote : {},
      brainByRepo: isRecordOfStrings(record.brainByRepo) ? record.brainByRepo : {}
    }
  } catch {
    return empty()
  }
}

export function writeBrainBindings(next: BrainBindings, file = brainBindingsFile()): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
}

function update(file: string, mutate: (bindings: BrainBindings) => void): void {
  const bindings = readBrainBindings(file)
  mutate(bindings)
  writeBrainBindings(bindings, file)
}

export function bindRepoToBrain(
  repoPath: string,
  brainPath: string,
  file = brainBindingsFile()
): void {
  update(file, (bindings) => {
    bindings.brainByRepo[repoPath] = brainPath
  })
}

export function unbindRepo(repoPath: string, file = brainBindingsFile()): void {
  update(file, (bindings) => {
    delete bindings.brainByRepo[repoPath]
  })
}

export function rememberClone(remote: string, clonePath: string, file = brainBindingsFile()): void {
  update(file, (bindings) => {
    bindings.clonesByRemote[remote] = clonePath
  })
}
