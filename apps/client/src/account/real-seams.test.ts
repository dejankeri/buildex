// The real Supabase (GoTrue) auth client. This module had no test net, and the one bug that
// mattered lived here: it sent an app-level `state` to /auth/v1/authorize.
//
// GoTrue OWNS the OAuth `state` parameter. It mints a UUID, stores the flow keyed by it, and
// forwards it to the provider. Supplying our own made GoTrue forward OURS to Google verbatim;
// when Google handed it back, GoTrue looked up a flow by a value it had never stored, found
// nothing, and redirected to redirect_to with `error=invalid_request`. Observed live on
// 2026-07-25 after a real Google authorization: "sign-in was denied: invalid_request".
//
// Our own one-time state is still required (invariant 7) - it rides in redirect_to's query
// instead, which GoTrue preserves when it appends `?code=` on the way back.
import { describe, it, expect } from "vitest";
import { realSupabaseAuthClient } from "./real-seams.js";

const client = () =>
  realSupabaseAuthClient({ supabaseUrl: "https://proj.supabase.co", anonKey: "anon-key", fetch });

const authorize = (): URL =>
  new URL(
    client().authorizeUrl({
      redirectUri: "http://127.0.0.1:54121/auth/callback",
      state: "one-time-state-abc",
      codeChallenge: "challenge-xyz",
    }),
  );

describe("realSupabaseAuthClient.authorizeUrl - GoTrue owns the OAuth state", () => {
  it("never sends an app-level `state` to /authorize", () => {
    // The regression: a `state` here is forwarded to the provider and breaks GoTrue's own
    // callback lookup. GoTrue must be left to mint and track its own.
    expect(authorize().searchParams.get("state")).toBeNull();
  });

  it("carries the one-time state in redirect_to's query, so the loopback can still validate it", () => {
    const back = new URL(authorize().searchParams.get("redirect_to")!);
    expect(back.origin + back.pathname).toBe("http://127.0.0.1:54121/auth/callback");
    expect(back.searchParams.get("state")).toBe("one-time-state-abc");
  });

  it("asks Google for a PKCE flow with the S256 challenge", () => {
    const u = authorize();
    expect(u.origin + u.pathname).toBe("https://proj.supabase.co/auth/v1/authorize");
    expect(u.searchParams.get("provider")).toBe("google");
    expect(u.searchParams.get("code_challenge")).toBe("challenge-xyz");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("does not double up the state if the redirect already carries one", () => {
    // Defensive: the loopback builds the redirect, and a future change there must not produce
    // `?state=a&state=b` - the callback reads a single value and would validate the wrong one.
    const url = client().authorizeUrl({
      redirectUri: "http://127.0.0.1:54121/auth/callback?state=stale",
      state: "fresh",
      codeChallenge: "c",
    });
    const back = new URL(new URL(url).searchParams.get("redirect_to")!);
    expect(back.searchParams.getAll("state")).toEqual(["fresh"]);
  });
});
