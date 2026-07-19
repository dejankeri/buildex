import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several suites drive real git (clone/commit/rebase/push in tmpdirs) and can exceed the 5s
    // default under parallel load. These are legitimately slow, not hung - give them room.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
