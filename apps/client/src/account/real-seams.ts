// The REAL adapters for sign-in.ts's seams (LoopbackServer / openBrowser / SupabaseAuthClient) plus
// its randomState/pkce generators. Constructed in wiring.ts ONLY when a Supabase client config is
// present (see ClientConfig.supabase) - unconfigured (the default today), none of this runs and
// `/api/signin` stays dormant.
//
// These are the one part of Task 10 that cannot be exercised end-to-end in a hermetic unit test: a
// real Supabase project and a real OS browser. They are deliberately small and closely follow
// Supabase's documented GoTrue endpoints, but MUST be verified against the live project at the
// owner's Supabase cutover (see the per-function notes below) - sign-in.ts's own tests already cover
// every OTHER edge (state/CSRF, timeout, denial, EADDRINUSE retry) against fakes of these interfaces.
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import type { LoopbackServer, SupabaseAuthClient } from "./sign-in.js";

/** A one-shot 127.0.0.1 HTTP server: listen(), then resolve the FIRST request's full URL (the OAuth
 *  redirect), then close(). One instance is used per sign-in attempt (see sign-in.ts). */
export function realLoopbackServer(): LoopbackServer {
  let server: http.Server | undefined;
  return {
    listen(port: number) {
      return new Promise((resolve, reject) => {
        const srv = http.createServer();
        srv.once("error", reject);
        srv.listen(port, "127.0.0.1", () => {
          server = srv;
          const boundPort = (srv.address() as AddressInfo).port;
          resolve({
            port: boundPort,
            waitForCallback: () =>
              new Promise<URL>((res) => {
                srv.once("request", (req, resp) => {
                  // A tiny, self-contained confirmation page - no redirect back into the app (the
                  // daemon isn't listening on this port), just tell the operator to return to buildex.
                  resp.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                  resp.end(
                    "<!doctype html><meta charset=\"utf-8\"><title>buildex</title>" +
                      "<body style=\"font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0\">" +
                      "Signed in - you can close this tab and return to buildex.</body>",
                  );
                  res(new URL(req.url ?? "/", `http://127.0.0.1:${boundPort}`));
                });
              }),
          });
        });
      });
    },
    close() {
      server?.close();
      server = undefined;
    },
  };
}

/** Open `url` in the operator's real browser. Prefers Electron's shell.openExternal when this process
 *  IS the Electron main process (the packaged app runs the daemon in-process there - see
 *  electron/main.cjs); `createRequire` keeps that require conditional so this module still loads
 *  fine in the plain-Node dev daemon, where the "electron" package is not resolvable. Falls back to
 *  the OS opener (`open` / `xdg-open` / `start`) via child_process, matching how the codebase already
 *  shells out for one-off OS commands (e.g. keychain.ts, usage.ts). */
export function openBrowser(url: string): void {
  try {
    const req = createRequire(import.meta.url);
    const electron = req("electron") as { shell?: { openExternal(u: string): Promise<void> } };
    if (electron?.shell?.openExternal) {
      void electron.shell.openExternal(url);
      return;
    }
  } catch {
    /* not running inside Electron (dev daemon, tests) - fall through to the OS-level opener */
  }
  if (process.platform === "darwin") {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  } else if (process.platform === "win32") {
    // `cmd /c start "" <url>` - the empty title arg keeps a URL containing spaces/special chars from
    // being misread as the window title by `start`.
    spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true, windowsHide: true }).unref();
  } else {
    spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  }
}

/** A one-time CSRF state token (invariant 7). */
export function randomState(): string {
  return randomBytes(24).toString("base64url");
}

/** PKCE verifier/challenge pair (RFC 7636, S256): verifier is random bytes, base64url-encoded;
 *  challenge is the base64url SHA-256 digest of the verifier's ASCII bytes. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** The real Supabase (GoTrue) auth client: PKCE OAuth (`authorizeUrl`/`exchangeCode`) plus no-browser
 *  anonymous sign-in (`signInAnonymously`). Based on Supabase's documented `/auth/v1/authorize`,
 *  `/auth/v1/token?grant_type=pkce`, and `/auth/v1/signup` (anonymous) endpoints - the exact
 *  query/body field names (and whether `provider=google` should instead be operator-choosable) MUST
 *  be verified against the owner's live Supabase project at cutover; nothing here has been exercised
 *  against a real project. */
export function realSupabaseAuthClient(deps: { supabaseUrl: string; anonKey: string; fetch: typeof fetch }): SupabaseAuthClient {
  const base = deps.supabaseUrl.replace(/\/+$/, "");
  return {
    authorizeUrl: ({ redirectUri, state, codeChallenge }) => {
      const u = new URL(base + "/auth/v1/authorize");
      u.searchParams.set("provider", "google");
      u.searchParams.set("redirect_to", redirectUri);
      u.searchParams.set("code_challenge", codeChallenge);
      u.searchParams.set("code_challenge_method", "S256");
      u.searchParams.set("state", state);
      return u.toString();
    },
    exchangeCode: async ({ code, codeVerifier, redirectUri }) => {
      let res: Response;
      try {
        res = await deps.fetch(base + "/auth/v1/token?grant_type=pkce", {
          method: "POST",
          headers: { "content-type": "application/json", apikey: deps.anonKey },
          body: JSON.stringify({ auth_code: code, code_verifier: codeVerifier, redirect_to: redirectUri }),
        });
      } catch (e) {
        throw new Error("could not reach the sign-in server: " + (e instanceof Error ? e.message : "network error"));
      }
      if (!res.ok) {
        let msg = `sign-in exchange failed (${res.status})`;
        try {
          const j = (await res.json()) as { error_description?: string; msg?: string; error?: string };
          msg = j.error_description ?? j.msg ?? j.error ?? msg;
        } catch {
          /* non-JSON error body - keep the status message */
        }
        throw new Error(msg);
      }
      let body: { access_token?: string };
      try {
        body = (await res.json()) as { access_token?: string };
      } catch {
        throw new Error("sign-in exchange returned a malformed response");
      }
      if (!body.access_token) throw new Error("sign-in exchange returned no access token");
      return { jwt: body.access_token };
    },
    // No-browser anonymous sign-in (anon-first onboarding). Based on Supabase's documented GoTrue
    // anonymous sign-up (`POST /auth/v1/signup` with an empty-credential body) - the exact
    // endpoint/body MUST be verified against the owner's live Supabase project at cutover, same as
    // authorizeUrl/exchangeCode above.
    signInAnonymously: async () => {
      let res: Response;
      try {
        res = await deps.fetch(base + "/auth/v1/signup", {
          method: "POST",
          headers: { "content-type": "application/json", apikey: deps.anonKey },
          body: JSON.stringify({}),
        });
      } catch (e) {
        throw new Error("could not reach the sign-in server: " + (e instanceof Error ? e.message : "network error"));
      }
      if (!res.ok) {
        let msg = `anonymous sign-in failed (${res.status})`;
        try {
          const j = (await res.json()) as { error_description?: string; msg?: string; error?: string };
          msg = j.error_description ?? j.msg ?? j.error ?? msg;
        } catch {
          /* non-JSON error body - keep the status message */
        }
        throw new Error(msg);
      }
      let body: { access_token?: string };
      try {
        body = (await res.json()) as { access_token?: string };
      } catch {
        throw new Error("anonymous sign-in returned a malformed response");
      }
      if (!body.access_token) throw new Error("anonymous sign-in returned no access token");
      return { jwt: body.access_token };
    },
  };
}
