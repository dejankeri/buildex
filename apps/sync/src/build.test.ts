import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(pkgRoot, "dist");

describe("build", () => {
  it("emits a runnable entrypoint and ships no test files", () => {
    rmSync(dist, { recursive: true, force: true });

    execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: pkgRoot, stdio: "pipe" });

    expect(existsSync(join(dist, "main.js"))).toBe(true);
    expect(existsSync(join(dist, "http", "app.js"))).toBe(true);
    expect(existsSync(join(dist, "store", "store.js"))).toBe(true);

    // Tests must never reach the image: they pull in vitest, which is not installed at runtime.
    const emitted = readdirSync(dist, { recursive: true, encoding: "utf8" });
    expect(emitted.filter((f) => f.includes(".test."))).toEqual([]);
  }, 120_000);
});
