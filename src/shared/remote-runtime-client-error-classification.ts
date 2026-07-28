export type RemoteRuntimeClientErrorLike = { code?: string; message: string }

const RECOVERABLE_CODES = new Set([
  'remote_runtime_unavailable',
  'runtime_timeout',
  'runtime_unavailable',
  'reconnecting',
  'timeout'
])

// Why both brands: this fork renames the runtime copy, but an Orca server (or
// upstream wording returning through a rebase) still emits "orca". Matching one
// name would silently reclassify recoverable drops as fatal.
const RECOVERABLE_MESSAGE_FRAGMENTS = [
  'could not connect to the remote {app} runtime',
  'remote {app} runtime closed the connection',
  'remote {app} runtime connection closed',
  'remote {app} runtime is not connected',
  'timed out waiting for the remote {app} runtime'
]
  .flatMap((fragment) => ['orca', 'buildex'].map((app) => fragment.replace('{app}', app)))
  .concat([
    'remote runtime connection closed',
    'remote runtime subscription closed before it started',
    'remote terminal stream is not connected'
  ])

export function isRecoverableRemoteRuntimeConnectionError(
  error: RemoteRuntimeClientErrorLike
): boolean {
  if (error.code && RECOVERABLE_CODES.has(error.code)) {
    return true
  }
  const message = error.message.toLowerCase()
  return RECOVERABLE_MESSAGE_FRAGMENTS.some((fragment) => message.includes(fragment))
}

export function toRemoteRuntimeClientErrorLike(error: unknown): RemoteRuntimeClientErrorLike {
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown }
    if (typeof candidate.message === 'string') {
      return {
        ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
        message: candidate.message
      }
    }
  }
  return { message: String(error) }
}
