import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several suites drive real git (clone/commit/rebase/push in tmpdirs) and can exceed the 5s
    // default under parallel load. These are legitimately slow, not hung - give them room.
    // Real-git suites (attach / open-account / no-token-on-disk / anonymous's real-rebase-conflict)
    // each fork many `git` subprocesses and are I/O-bound, not CPU-bound. Two knobs keep them
    // deterministic without over-serializing the fast jsdom/unit suites: a generous per-test timeout
    // (60s of headroom so a contended git op doesn't trip it) and a modest worker cap (3) so concurrent
    // git files don't oversubscribe disk I/O. maxWorkers=4 flaked under heavy `task ci` load once
    // enough real-git files landed; maxWorkers=2 was deterministic but too slow. 3 + 60s balances both.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    maxWorkers: 3,
    minWorkers: 1,
  },
});
