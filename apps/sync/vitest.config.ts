import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The git-service, dogfood, and restore-drill suites drive real git and node:sqlite; allow
    // headroom over the 5s default so parallel load never trips a false timeout.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    poolOptions: {
      forks: {
        // node:sqlite is experimental on Node 22; silence its ExperimentalWarning in the test
        // workers here (not via a POSIX env prefix in package.json, which cmd.exe can't parse).
        execArgv: ["--disable-warning=ExperimentalWarning"],
      },
    },
  },
});
