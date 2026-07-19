// Tests that secret-scan.sh actually catches the token formats this codebase handles. It runs the
// real script against a throwaway fixture tree (the script takes an optional scan-root arg for
// exactly this). Sample secrets are built by concatenation so this tracked test file never contains a
// scannable literal - otherwise the repo's own secret-scan would flag this very file.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// apps/toolkit/src → repo root → scripts/secret-scan.sh
const SCAN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "secret-scan.sh");

// Realistic shapes for each pattern, assembled so no literal secret appears in this source file.
const SAMPLES: Record<string, string> = {
  "machine token": "xmachine_" + "a1b2c3d4".repeat(4),
  "refresh token": "xrefresh_" + "a1b2c3d4".repeat(4),
  "setup token": "xsetup_" + "a1b2c3d4".repeat(4),
  "github fine-grained PAT": "github_pat_" + "A1b2C3d4E5".repeat(3),
  "JWT": "eyJ" + "abcdefghij".repeat(2) + "." + "eyJ" + "klmnopqrst".repeat(2) + "." + "sig1234567890",
  "AWS access key": "AKIA" + "ABCDEFGHIJKLMNOP",
  "Anthropic key": "sk-ant-" + "x9y8z7w6v5u4t3s2r1q0",
};

function runScan(dir: string): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync("bash", [SCAN, dir], { encoding: "utf8" }) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { code: err.status ?? 1, out: err.stdout ?? "" };
  }
}

describe("secret-scan.sh - the pattern floor catches this codebase's token formats", () => {
  it("passes on a clean tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "scan-clean-"));
    try {
      writeFileSync(join(dir, "ok.md"), "# hello\n\njust some docs - nothing secret here.\n");
      expect(runScan(dir).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const [label, secret] of Object.entries(SAMPLES)) {
    it(`flags a ${label} and exits non-zero`, () => {
      const dir = mkdtempSync(join(tmpdir(), "scan-bad-"));
      try {
        writeFileSync(join(dir, "leak.txt"), `token=${secret}\n`);
        const res = runScan(dir);
        expect(res.code, `scan should have failed for ${label}`).not.toBe(0);
        expect(res.out).toMatch(/SECRET-SCAN/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
