import type { i18n as I18nInstance, TOptions } from 'i18next'

// Stably's own products and infrastructure, not this app: the CLI binary is
// literally `orca` (verify-cli-bin.mjs requires it), and Cloud and Relay
// resolve to login.onorca.dev and relay-c1.onorca.dev.
const UPSTREAM_PRODUCTS = ['CLI', 'Cloud', 'Relay'] as const

// Capital-only by design. Every lowercase `orca` in the catalog is a real
// identifier (orca.yaml, .orca/, `orca worktree create`, orca://pair, orca on
// PATH), and `\bORCA\b` cannot match ORCA_* env vars because `_` is a word
// character — so both are protected without an explicit list.
const APP_NAME = new RegExp(`\\bOrca\\b(?!\\s+(?:${UPSTREAM_PRODUCTS.join('|')})\\b)`, 'g')
const WORDMARK = /\bORCA\b/g

// Keys this fork authors itself, which are exempt from rebranding.
const BUILDEX_KEY_PREFIX = 'buildex.'

export function isBuildExAuthoredKey(key: string): boolean {
  return key.startsWith(BUILDEX_KEY_PREFIX)
}

export function applyBuildExBrand(template: string): string {
  return template.replace(APP_NAME, 'BuildEx').replace(WORDMARK, 'BUILDEX')
}

/**
 * Resolves a key to its template, brands the template, and only then
 * interpolates.
 *
 * Order matters: interpolated values carry user data, so a repository named
 * `stablyai/Orca` has to survive `{{repo}} isn't added to Orca`.
 */
export function brandedTranslate(
  i18n: I18nInstance,
  key: string,
  fallback: string,
  options?: TOptions
): string {
  if (isBuildExAuthoredKey(key)) {
    // BuildEx-authored copy is already correct; rewriting it would turn our own
    // "built on Orca" credit into "built on BuildEx".
    return i18n.isInitialized ? i18n.t(key, { defaultValue: fallback, ...options }) : fallback
  }

  if (!i18n.isInitialized) {
    // Menu registration can run before async init finishes; match i18next's own
    // behaviour of returning the uninterpolated fallback rather than undefined.
    return applyBuildExBrand(fallback)
  }

  // skipInterpolation is honoured at runtime (i18next.js:743) but undocumented;
  // TOptions' index signature is what makes passing it typecheck.
  const raw = i18n.t(key, { defaultValue: fallback, ...options, skipInterpolation: true })

  const template = typeof raw === 'string' && raw.length > 0 ? raw : fallback
  const branded = applyBuildExBrand(template)

  // The catalog uses no $t() nesting and no caller passes `replace`, so options
  // double as the interpolation data. The trailing argument only supplies
  // missingInterpolationHandler / skipOnVariables, which nothing here overrides.
  return i18n.services.interpolator.interpolate(branded, options ?? {}, i18n.language, {})
}
