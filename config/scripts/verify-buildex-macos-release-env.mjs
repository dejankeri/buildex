#!/usr/bin/env node

// BuildEx's macOS release pre-flight. Upstream's verify-macos-release-env.mjs
// hardcodes Orca's release machine: Apple ID + app-specific password for the
// notary, and a base64 .p12 in CSC_LINK for signing. Both of those are one valid
// setup, not the only one — @electron/notarize also takes an App Store Connect
// API key, and electron-builder signs from a Developer ID already in the login
// keychain. Rejecting that combination fails a build that would have succeeded.
//
// Kept as a BuildEx-owned file so the upstream script stays untouched and this
// never conflicts on rebase.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const problems = []

function isSet(key) {
  const value = process.env[key]
  return typeof value === 'string' && value.trim().length > 0
}

if (!isSet('APPLE_TEAM_ID')) {
  problems.push('APPLE_TEAM_ID is required for both notarization flows.')
}

// Notarization: App Store Connect API key, or Apple ID + app-specific password.
const apiKeyVars = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']
const hasAnyApiKeyVar = apiKeyVars.some(isSet)
const hasAllApiKeyVars = apiKeyVars.every(isSet)
const hasAppleId = isSet('APPLE_ID') && isSet('APPLE_APP_SPECIFIC_PASSWORD')

if (hasAllApiKeyVars) {
  // Why: notarytool reports a missing key as an auth failure ~20 minutes in,
  // after the upload. Cheaper to catch the typo now.
  if (!existsSync(process.env.APPLE_API_KEY)) {
    problems.push(
      `APPLE_API_KEY points at a file that does not exist: ${process.env.APPLE_API_KEY}`
    )
  }
} else if (hasAnyApiKeyVar) {
  problems.push(
    `Partial App Store Connect key: set all of ${apiKeyVars.join(', ')} (missing ${apiKeyVars.filter((k) => !isSet(k)).join(', ')}).`
  )
} else if (!hasAppleId) {
  problems.push(
    'No notarization credentials. Set either APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD.'
  )
}

// Signing: an imported .p12, or a Developer ID already in the login keychain.
if (!(isSet('CSC_LINK') && isSet('CSC_KEY_PASSWORD'))) {
  let keychainIdentities = ''
  try {
    keychainIdentities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8'
    })
  } catch {
    keychainIdentities = ''
  }
  if (!keychainIdentities.includes('Developer ID Application')) {
    problems.push(
      'No signing identity: set CSC_LINK + CSC_KEY_PASSWORD, or install a "Developer ID Application" certificate in the login keychain.'
    )
  }
}

if (problems.length > 0) {
  console.error('BuildEx macOS release build is not configured:')
  for (const problem of problems) {
    console.error(`- ${problem}`)
  }
  console.error('')
  console.error('Use `pnpm build:mac` for an unsigned local build.')
  process.exit(1)
}
