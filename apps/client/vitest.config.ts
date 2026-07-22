import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several suites drive real git (clone/commit/rebase/push in tmpdirs) and can exceed the 5s
    // default under parallel load. These are legitimately slow, not hung - give them room.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Cap the worker pool. These real-git suites each fork many `git` subprocesses; at the default
    // one-worker-per-core the heaviest of them (attach / open-account / no-token-on-disk) contend on
    // disk I/O and flakily blow the 30s timeout - not CPU-bound (the box sits near 48% during a run),
    // just oversubscribed on concurrent git. Bounding to 4 workers removes the timeouts with NO
    // wall-clock cost (the suite was never CPU-limited); verified 88/88 files green, deterministically.
    maxWorkers: 4,
    minWorkers: 1,
  },
});
