import { describe, it, expect, vi } from "vitest";
import type { SignInDeps, LoopbackServer, SupabaseAuthClient } from "./sign-in.js";
import { signIn } from "./sign-in.js";

// A one-shot fake loopback: listen() resolves immediately with a fixed port and a
// waitForCallback() that resolves to whatever URL the test hands it. No real socket,
// no real network - the test drives the "browser redirect" by resolving a promise.
function fakeLoopback(
  cb: () => Promise<URL>,
  opts?: { failFirstListen?: boolean },
): LoopbackServer & { closed: boolean; listenCalls: number[] } {
  const server = {
    closed: false,
    listenCalls: [] as number[],
    async listen(port: number) {
      server.listenCalls.push(port);
      if (opts?.failFirstListen && server.listenCalls.length === 1) {
        const err = new Error("address in use") as NodeJS.ErrnoException;
        err.code = "EADDRINUSE";
        throw err;
      }
      return { port: port === 0 ? 61234 : port, waitForCallback: cb };
    },
    close() {
      server.closed = true;
    },
  };
  return server;
}

function fakeSupabase(jwt: string): SupabaseAuthClient & { exchangeCalls: unknown[]; authorizeCalls: unknown[] } {
  const authorizeCalls: unknown[] = [];
  const exchangeCalls: unknown[] = [];
  return {
    authorizeCalls,
    exchangeCalls,
    authorizeUrl(args) {
      authorizeCalls.push(args);
      return `https://supabase.test/authorize?redirect_uri=${encodeURIComponent(args.redirectUri)}&state=${args.state}&code_challenge=${args.codeChallenge}`;
    },
    async exchangeCode(args) {
      exchangeCalls.push(args);
      return { jwt };
    },
  };
}

function baseDeps(overrides: Partial<SignInDeps> = {}): SignInDeps {
  return {
    openBrowser: vi.fn(),
    loopback: fakeLoopback(async () => new URL("http://127.0.0.1:54121/auth/callback?code=abc123&state=the-state")),
    supabase: fakeSupabase("xjwt_result"),
    now: () => 0,
    randomState: () => "the-state",
    pkce: () => ({ verifier: "the-verifier", challenge: "the-challenge" }),
    ...overrides,
  };
}

describe("signIn", () => {
  it("happy path: opens the browser, waits for the callback, and exchanges the code for a jwt", async () => {
    const loopback = fakeLoopback(async () => new URL("http://127.0.0.1:54121/auth/callback?code=abc123&state=the-state"));
    const supabase = fakeSupabase("xjwt_result");
    const openBrowser = vi.fn();
    const deps = baseDeps({ loopback, supabase, openBrowser });

    const result = await signIn(deps, {});

    expect(result).toEqual({ jwt: "xjwt_result" });

    expect(openBrowser).toHaveBeenCalledTimes(1);
    const openedUrl = openBrowser.mock.calls[0]![0] as string;
    expect(openedUrl).toContain("the-challenge");
    expect(openedUrl).toContain("the-state");

    expect(supabase.exchangeCalls).toEqual([
      { code: "abc123", codeVerifier: "the-verifier", redirectUri: "http://127.0.0.1:54121/auth/callback" },
    ]);

    expect(loopback.closed).toBe(true); // always closed, even on the happy path
  });

  it("state mismatch: rejects, never exchanges the code, but still closes the loopback (CSRF defense)", async () => {
    const loopback = fakeLoopback(async () => new URL("http://127.0.0.1:54121/auth/callback?code=abc123&state=WRONG-STATE"));
    const supabase = fakeSupabase("xjwt_result");
    const deps = baseDeps({ loopback, supabase });

    await expect(signIn(deps, {})).rejects.toThrow(/state/i);

    expect(supabase.exchangeCalls).toEqual([]);
    expect(loopback.closed).toBe(true);
  });

  it("provider denial: error=access_denied in the callback rejects and closes the loopback", async () => {
    const loopback = fakeLoopback(async () => new URL("http://127.0.0.1:54121/auth/callback?error=access_denied&state=the-state"));
    const supabase = fakeSupabase("xjwt_result");
    const deps = baseDeps({ loopback, supabase });

    await expect(signIn(deps, {})).rejects.toThrow(/access_denied/i);

    expect(supabase.exchangeCalls).toEqual([]);
    expect(loopback.closed).toBe(true);
  });

  it("missing code: rejects and closes the loopback", async () => {
    const loopback = fakeLoopback(async () => new URL("http://127.0.0.1:54121/auth/callback?state=the-state"));
    const supabase = fakeSupabase("xjwt_result");
    const deps = baseDeps({ loopback, supabase });

    await expect(signIn(deps, {})).rejects.toThrow(/code/i);

    expect(supabase.exchangeCalls).toEqual([]);
    expect(loopback.closed).toBe(true);
  });

  it("timeout: a callback arriving past the TTL is rejected and never exchanged", async () => {
    let callCount = 0;
    const now = () => {
      callCount++;
      if (callCount === 1) return 0; // start time at first call
      return 300001; // 300001ms later at second call (exceeds 300000ms timeout)
    };

    const loopback = fakeLoopback(async () => new URL("http://127.0.0.1:54121/auth/callback?code=abc123&state=the-state"));
    const supabase = fakeSupabase("xjwt_result");
    const deps = baseDeps({ loopback, supabase, now });

    await expect(signIn(deps, { timeoutMs: 300000 })).rejects.toThrow(/timed out/i);

    expect(supabase.exchangeCalls).toEqual([]);
    expect(loopback.closed).toBe(true);
  });

  it("EADDRINUSE on the fixed port fails cleanly - a random port is not a usable fallback " +
    "(the Supabase project only allowlists the fixed port's redirect URI)", async () => {
    const loopback = fakeLoopback(
      async () => new URL("http://127.0.0.1:61234/auth/callback?code=abc123&state=the-state"),
      { failFirstListen: true },
    );
    const supabase = fakeSupabase("xjwt_result");
    const openBrowser = vi.fn();
    const deps = baseDeps({ loopback, supabase, openBrowser });

    await expect(signIn(deps, { port: 54121 })).rejects.toThrow(/sign-in port is busy/i);

    expect(loopback.listenCalls).toEqual([54121]); // no fallback retry on a random port
    expect(openBrowser).not.toHaveBeenCalled();
    expect(supabase.exchangeCalls).toEqual([]);
  });
});
