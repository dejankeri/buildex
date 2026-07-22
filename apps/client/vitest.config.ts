import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several suites drive real git (clone/commit/rebase/push in tmpdirs) and can exceed the 5s
    // default under parallel load. These are legitimately slow, not hung - give them room.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Cap the worker pool. These real-git suites each fork many `git` subprocesses; at the default
    // one-worker-per-core the heaviest of them (attach / open-account / no-token-on-disk /
    // anonymous's real-rebase-conflict case) contend on disk I/O and flakily blow the 30s timeout -
    // not CPU-bound, just oversubscribed on concurrent git. Started at 4; lowered to 2 as more heavy
    // real-git files landed (Phase 3 + anonymous onboarding) and 4 began flaking under `task ci` load.
    // 2 keeps at most two heavy git files running at once; costs some wall-clock, buys determinism.
    maxWorkers: 2,
    minWorkers: 1,
  },
});
