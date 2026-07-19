#!/usr/bin/env bash
# secret-scan — invariant floor: no secret/credential ever enters this public repo's history.
# Scans git-tracked files (falls back to the working tree if not a git repo) for high-signal
# secret patterns. Exit non-zero on any hit. This is a floor, not a substitute for judgment.
# Portable: POSIX sh compatible (no mapfile/arrays-from-procsub) — runs under macOS bash 3.2 and sh.
set -eu

# Scan root: the repo (default) or a directory passed as $1 (used by the scan's own test to point it
# at a fixture tree of planted secrets). When given a non-git dir, list_files falls back to the tree.
ROOT="${1:-$(dirname "$0")/..}"
cd "$ROOT"

# This scanner file itself defines the patterns — don't scan it (self-match).
SELF="scripts/secret-scan.sh"

# High-signal patterns (newline-separated). Precise, to avoid false positives on a public spec repo.
# Covers the token formats this codebase actually handles: cloud keys, provider API keys, GitHub
# classic + fine-grained PATs, Slack/Google keys, JWTs (header.payload.sig), and BuildEx's own minted
# tokens (setup / machine / refresh — see the sync provisioning + connector gateway).
PATTERNS='-----BEGIN [A-Z ]*PRIVATE KEY-----
AKIA[0-9A-Z]{16}
ASIA[0-9A-Z]{16}
sk-ant-[A-Za-z0-9_-]{20,}
sk-[A-Za-z0-9]{32,}
ghp_[A-Za-z0-9]{36,}
gho_[A-Za-z0-9]{36,}
github_pat_[0-9a-zA-Z_]{22,}
xox[baprs]-[A-Za-z0-9-]{10,}
AIza[0-9A-Za-z_-]{35}
eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}
xsetup_[A-Za-z0-9_-]{16,}
xmachine_[A-Za-z0-9_-]{16,}
xrefresh_[A-Za-z0-9_-]{16,}'

# File list: tracked files if in git, else the working tree.
list_files() {
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git ls-files
  else
    find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*'
  fi
}

hits=0
count=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  count=$((count + 1))
  [ "$f" = "$SELF" ] && continue
  [ -f "$f" ] || continue
  # Skip obviously-binary files.
  if file "$f" 2>/dev/null | grep -qi 'binary\|image\|archive'; then continue; fi
  while IFS= read -r pat; do
    [ -n "$pat" ] || continue
    if grep -nEI "$pat" "$f" >/dev/null 2>&1; then
      echo "SECRET-SCAN: potential secret in $f (pattern: $pat)"
      grep -nEI "$pat" "$f" | sed 's/^/    /'
      hits=$((hits + 1))
    fi
  done <<EOF
$PATTERNS
EOF
done <<EOF
$(list_files)
EOF

if [ "$hits" -gt 0 ]; then
  echo ""
  echo "secret-scan FAILED: $hits potential secret(s) found. Remove them and rewrite history if committed."
  exit 1
fi
echo "secret-scan OK: scanned $count tracked file(s), no secrets found."
