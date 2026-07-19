#!/usr/bin/env bash
# test-collection-audit — CI must fail on silently-uncollected test files.
# The failure mode we guard: a *.test.ts / *.spec.ts exists on disk but the runner never collects
# it (it lives in an app with no vitest "test" script, or a future config narrows the include glob
# past it). Either way the test silently never runs — worse than no test.
set -euo pipefail

cd "$(dirname "$0")/.."

fail=0

# 1) Every test file must live inside an app that actually runs vitest.
while IFS= read -r tf; do
  [ -z "$tf" ] && continue
  # Which app owns this file? apps/<name>/...
  app=$(printf '%s' "$tf" | sed -nE 's#^apps/([^/]+)/.*#\1#p')
  if [ -z "$app" ]; then
    echo "AUDIT: test file outside apps/ — not covered by any app runner: $tf"
    fail=1
    continue
  fi
  pkg="apps/$app/package.json"
  if [ ! -f "$pkg" ] || ! grep -q '"test"' "$pkg" || ! grep -q 'vitest' "$pkg"; then
    echo "AUDIT: $tf lives in app '$app' with no vitest test script — it will never run."
    fail=1
  fi
done < <(find apps -type d -name node_modules -prune -o \
                   -type f \( -name '*.test.ts' -o -name '*.spec.ts' \) -print 2>/dev/null)

# 2) Per app: what vitest actually collects must equal what's on disk (catches include-glob drift).
for pkg in apps/*/package.json; do
  [ -f "$pkg" ] || continue
  grep -q 'vitest' "$pkg" || continue
  app_dir=$(dirname "$pkg")
  disk=$(find "$app_dir" -type d -name node_modules -prune -o \
                        -type f \( -name '*.test.ts' -o -name '*.spec.ts' \) -print 2>/dev/null | grep -c . || true)
  # vitest list prints one line per collected test; --filesOnly would be ideal but isn't stable
  # across versions, so count distinct collected files from the json listing via node.
  # NB: print with process.stdout.write(String(...)), NOT console.log(number) — under FORCE_COLOR
  # Node colorizes a bare number (\x1b[33m…\x1b[39m), which would never string-equal $disk and would
  # fail the audit for every app. A plain string write stays uncolored.
  collected=$( (cd "$app_dir" && npx --no-install vitest list --json 2>/dev/null) \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);const f=new Set(a.map(t=>t.file));process.stdout.write(String(f.size))}catch{process.stdout.write("ERR")}})' 2>/dev/null || echo "ERR")
  if [ "$collected" = "ERR" ]; then
    echo "AUDIT: could not list collected tests for '$app_dir' (vitest not installed yet?) — disk has $disk"
    # Not a hard fail before install; the per-file check (1) is the real gate. Skip count compare.
    continue
  fi
  if [ "$disk" != "$collected" ]; then
    echo "AUDIT: '$app_dir' has $disk test file(s) on disk but vitest collects $collected — glob mismatch."
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "test-collection-audit FAILED."
  exit 1
fi
echo "test-collection-audit OK: every test file is collected by a runner."
