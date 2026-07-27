// Why: single source of truth for the commit trailer Orca appends when the
// "Orca Attribution" toggle (`enableGitHubAttribution`) is on. Used by both
// the terminal git/gh shim and the AI commit-message generator so the two
// code paths agree on the exact string.

// BuildEx: this string lands in the operator's real commit history, so it must
// name the product they are running. Leaving it as upstream would credit Orca
// for every commit made from a BuildEx terminal.
export const ORCA_GIT_COMMIT_TRAILER = 'Co-authored-by: BuildEx <noreply@buildex.app>'
