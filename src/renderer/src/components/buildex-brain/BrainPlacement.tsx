import React, { useState } from 'react'
import { Brain, Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { BrainResolution } from '../../../../shared/buildex-brain-types'

// What the Brain screen shows when there is no brain to show.
//
// Every state here is one the operator has to act on, so each says what
// happened, names the path or remote it happened to, and offers the one or two
// things that can be done about it. Nothing else on the screen renders while
// this does: a brain that cannot be resolved has no sections, no history and no
// documents to be honest about.

export default function BrainPlacement({
  resolution,
  onClone,
  onDisconnect
}: {
  resolution: BrainResolution | null
  onClone: (targetPath: string) => Promise<void>
  onDisconnect: () => Promise<void>
}): React.JSX.Element | null {
  const needsClone = resolution?.status === 'needs-clone' ? resolution : null
  const [targetPath, setTargetPath] = useState(needsClone?.suggestedPath ?? '')
  const [busy, setBusy] = useState(false)

  if (!resolution || resolution.status === 'ready') {
    return null
  }

  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busy) {
      return
    }
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  const spinner = busy ? <Loader2 size={12} className="animate-spin" /> : null

  return (
    <div className="scrollbar-sleek flex min-h-0 flex-1 justify-center overflow-y-auto px-6 py-10">
      <div className="w-full max-w-xl">
        <div className="flex items-center gap-2">
          <Brain size={18} className="text-muted-foreground" />
          <h2 className="text-[15px] font-semibold tracking-tight">
            {resolution.status === 'needs-clone'
              ? translate(
                  'buildex.brain.placement.needsCloneTitle',
                  "This company's brain lives in its own repo"
                )
              : resolution.reason === 'missing'
                ? translate(
                    'buildex.brain.placement.missingTitle',
                    'The brain folder is not there any more'
                  )
                : translate(
                    'buildex.brain.placement.notARepoTitle',
                    'That folder is not a git repo'
                  )}
          </h2>
        </div>

        <p className="mt-2 break-all font-mono text-[12px] text-muted-foreground">
          {resolution.status === 'needs-clone' ? resolution.remote : resolution.path}
        </p>

        <p className="mt-3 text-[12px] leading-relaxed text-muted-foreground">
          {resolution.status === 'needs-clone'
            ? translate(
                'buildex.brain.placement.needsCloneBody',
                'Clone it and this repo picks up the decisions, rules and skills the company has already written.'
              )
            : resolution.status === 'broken' && resolution.reason === 'missing'
              ? translate(
                  'buildex.brain.placement.missingBody',
                  'Nothing was deleted from here — this repo points at a folder that has moved or gone. Put it back where it was, or disconnect this repo from it.'
                )
              : translate(
                  'buildex.brain.placement.notARepoBody',
                  'Without git there is no history and nothing to share, so the brain cannot be used from here.'
                )}
        </p>

        {needsClone ? (
          <input
            aria-label={translate('buildex.brain.placement.pathLabel', 'Where to clone it')}
            value={targetPath}
            onChange={(event) => setTargetPath(event.target.value)}
            className="mt-4 h-9 w-full rounded-md border border-border bg-background px-3 font-mono text-[12px] outline-none focus:border-ring"
          />
        ) : null}

        <div className="mt-5 flex items-center gap-3">
          {needsClone ? (
            <button
              type="button"
              onClick={() => void run(() => onClone(targetPath.trim()))}
              disabled={busy || !targetPath.trim()}
              className="inline-flex h-8 items-center gap-2 rounded-md bg-primary px-3 text-[12px] font-medium text-primary-foreground disabled:opacity-50"
            >
              {spinner}
              {translate('buildex.brain.placement.clone', 'Clone the brain')}
            </button>
          ) : null}
          {resolution.status === 'broken' ? (
            <button
              type="button"
              onClick={() => void run(onDisconnect)}
              disabled={busy}
              className="inline-flex h-8 items-center gap-2 rounded-md border border-border px-3 text-[12px] font-medium disabled:opacity-50"
            >
              {translate('buildex.brain.placement.disconnect', 'Disconnect this repo')}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
