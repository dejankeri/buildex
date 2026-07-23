import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Some toolkit suites drive real git (init/commit/log in tmpdirs — e.g. the history-secret-audit
    // gate) and can exceed the 5s default under parallel `task ci` load: the audit passes in ~5-8s
    // in isolation but flakily times out at 5s when the machine is contended. These are legitimately
    // slow (real subprocesses), not hung — give them the same 30s headroom apps/client's real-git
    // suites use. Also cap the worker pool so concurrent git subprocesses don't oversubscribe.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    maxWorkers: 4,
    minWorkers: 1,
  },
});
