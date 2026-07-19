// History secret gate: scan ALL git history for secrets. Run via
// `task audit-history`. Exits non-zero if anything is found, so it can gate the flip in CI or by hand.
import { auditHistory } from "../apps/toolkit/src/history-secret-audit.js";

const res = auditHistory(process.cwd());
if (res.clean) {
  console.log("✅ HISTORY CLEAN - no secrets in any commit. Safe to flip public.");
  process.exit(0);
}
console.error(`❌ SECRETS FOUND IN HISTORY (${res.findings.length}). Do NOT flip public until history is rewritten:`);
for (const f of res.findings) console.error(`  ${f.commit}  ${f.file}  (${f.pattern})`);
process.exit(1);
