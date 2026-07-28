import React, { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Plus, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { BrainSkill } from '../../../../shared/buildex-brain-types'

// Skills: what this company's agent knows how to do here.
//
// Sharing is git — `.buildex/skills/` is tracked, so a teammate who pulls gets
// them, and the link into `.claude/skills/` is rebuilt on their machine when
// they open the project. Nothing is uploaded anywhere.

export default function BrainSkills({
  repoPath,
  brainRoot,
  onOpenPath
}: {
  repoPath: string | null
  /** The resolved brain's root — `.buildex/` in a repo, or an external repo's own root. */
  brainRoot: string | null
  onOpenPath: (absolutePath: string, relativePath: string) => void
}): React.JSX.Element {
  const [skills, setSkills] = useState<BrainSkill[]>([])
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const activeWorktree = useAppStore((s) => s.activeWorktreeId)

  const refresh = useCallback(async (): Promise<void> => {
    if (!repoPath) {
      setSkills([])
      return
    }
    const result = await window.api.buildexBrainSections.skills({ repoPath })
    setSkills(result.skills)
  }, [repoPath])

  useEffect(() => {
    void refresh()
  }, [refresh, activeWorktree])

  const create = async (): Promise<void> => {
    const name = title.trim()
    if (!repoPath || !name) {
      setCreating(false)
      return
    }
    const result = await window.api.buildexBrainSections.createSkill({ repoPath, title: name })
    setCreating(false)
    setTitle('')
    if (!result.ok) {
      setError(result.error ?? 'Could not create the skill')
      return
    }
    setError(null)
    await refresh()
    if (result.absolutePath && result.name) {
      onOpenPath(result.absolutePath, `skills/${result.name}/SKILL.md`)
    }
  }

  // Every skill in the brain is the company's now. An installed app's skills
  // live in the agent's plugin cache, not here.
  const company = skills.filter((skill) => skill.source === 'company')

  return (
    <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mb-4 flex items-center gap-2">
        <p className="text-[12px] text-muted-foreground">
          {translate(
            'buildex.brain.skills.intro',
            'Skills live in the brain and travel with it — push, and your team has them.'
          )}
        </p>
        {creating ? null : (
          <button
            type="button"
            disabled={!repoPath}
            onClick={() => {
              setTitle('')
              setCreating(true)
            }}
            className="ml-auto inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-primary px-2 text-[12px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            <Plus size={12} />
            {translate('buildex.brain.skills.new', 'New skill')}
          </button>
        )}
      </div>

      {creating ? (
        <input
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => setCreating(false)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              void create()
            }
            if (event.key === 'Escape') {
              setCreating(false)
            }
          }}
          placeholder={translate(
            'buildex.brain.skills.namePlaceholder',
            'What should the agent be able to do? e.g. "onboard a new client"'
          )}
          className="mb-4 h-8 w-full rounded-md border border-input bg-background px-2 text-[12px] outline-none focus:ring-[3px] focus:ring-ring/50"
        />
      ) : null}

      {error ? <p className="mb-3 text-[12px] text-destructive">{error}</p> : null}

      <SkillGroup
        title={translate('buildex.brain.skills.company', 'Written here')}
        hint={translate(
          'buildex.brain.skills.companyHint',
          'Yours. Edit freely — nothing overwrites these.'
        )}
        skills={company}
        brainRoot={brainRoot}
        onOpenPath={onOpenPath}
      />

      {skills.length === 0 ? (
        <p className="text-[12px] text-muted-foreground/70">
          {translate(
            'buildex.brain.skills.empty',
            'No skills yet. Write one, or install an app from the Store.'
          )}
        </p>
      ) : null}
    </div>
  )
}

function SkillGroup({
  title,
  hint,
  skills,
  brainRoot,
  onOpenPath
}: {
  title: string
  hint: string
  skills: BrainSkill[]
  brainRoot: string | null
  onOpenPath: (absolutePath: string, relativePath: string) => void
}): React.JSX.Element | null {
  if (skills.length === 0) {
    return null
  }
  return (
    <section className="mb-5">
      <h2 className="text-[11px] font-semibold tracking-[0.05em] text-muted-foreground/70 uppercase">
        {title}
      </h2>
      <p className="mb-2 text-[11px] text-muted-foreground/60">{hint}</p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2">
        {skills.map((skill) => (
          <button
            key={skill.name}
            type="button"
            onClick={() =>
              brainRoot
                ? onOpenPath(
                    `${brainRoot.replace(/[/\\]$/, '')}/skills/${skill.name}/SKILL.md`,
                    `skills/${skill.name}/SKILL.md`
                  )
                : undefined
            }
            className="flex flex-col gap-1 rounded-xl border border-border bg-card p-3 text-left shadow-xs transition-colors hover:bg-accent"
          >
            <span className="flex items-center gap-1.5">
              <Sparkles size={12} className="shrink-0 text-muted-foreground/50" />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{skill.title}</span>
              {/* Why: an unlinked skill is invisible to the agent, which looks
                  identical to a skill that simply is not working. Say it. */}
              {skill.linked ? null : (
                <AlertTriangle size={12} className="shrink-0 text-amber-500" />
              )}
            </span>
            <span className="text-[11px] text-muted-foreground/70">{skill.name}</span>
            {skill.description ? (
              <span className={cn('line-clamp-2 text-[12px] text-muted-foreground')}>
                {skill.description}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </section>
  )
}
