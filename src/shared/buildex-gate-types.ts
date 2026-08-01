// The gate: which of the agent's actions run on their own, and which wait for a
// human tap. BuildEx's stance is wide autonomy with few gates — local work,
// edits, reads and web access are autonomous; money, outbound-to-people and
// irreversible destruction wait for a person.
//
// The preset is written into the company repo's .claude/settings.json and
// enforced there by the agent's own runtime. BuildEx deliberately evaluates
// nothing itself — a second decision path could only disagree with the file the
// agent actually reads.

export type GateDecision = 'allow' | 'ask' | 'deny'

export type GatePreset = {
  allow: string[]
  ask: string[]
  deny: string[]
  /** Decision for a tool no rule matches. */
  default: GateDecision
}

/** Where the effective preset came from, for the UI to explain itself. */
export type GatePresetSource = 'repo' | 'bundle'

export type GateSettingsRequest = {
  repoPath: string
}

export type GateSettingsResult = {
  preset: GatePreset
  source: GatePresetSource
  /** True when .claude/settings.json changed on this sync. */
  settingsChanged: boolean
  /** Rules the operator added by hand that this sync preserved. */
  preservedRules: string[]
  error?: string
}

export const GATE_PRESET_RELATIVE_PATH = '.buildex/gate-preset.json'
export const CLAUDE_SETTINGS_RELATIVE_PATH = '.claude/settings.json'
