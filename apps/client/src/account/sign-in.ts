// Desktop sign-in: system browser + PKCE + a one-time-state loopback listener (invariant 7:
// identity from JWT only; state is one-time and short-TTL). Every fallible edge - the browser
// process, the local listener, the Supabase HTTP round-trip, randomness, and the clock - is an
// injected seam so this whole flow runs hermetically under fakes: no real socket, no real browser
// window, no real timers.
//
// The loopback owns the actual waiting (it is the only seam that can plausibly hang), so the TTL
// here is enforced as a `deps.now()` delta around that wait rather than a real timer - a fake
// clock can jump forward across the await without needing fake timers.
export interface LoopbackServer {
  listen(port: number): Promise<{ port: number; waitForCallback(): Promise<URL> }>;
  close(): void;
}

export interface SupabaseAuthClient {
  authorizeUrl(args: { redirectUri: string; state: string; codeChallenge: string }): string;
  exchangeCode(args: { code: string; codeVerifier: string; redirectUri: string }): Promise<{ jwt: string }>;
  /** No-browser anonymous sign-in (GoTrue anonymous sign-up) - the anon-first onboarding path that
   *  skips the loopback/PKCE dance entirely. */
  signInAnonymously(): Promise<{ jwt: string }>;
}

export interface SignInDeps {
  openBrowser(url: string): void;
  loopback: LoopbackServer;
  supabase: SupabaseAuthClient;
  now: () => number;
  randomState(): string;
  pkce(): { verifier: string; challenge: string };
}

const DEFAULT_PORT = 54121; // the callback URL registered with Supabase for this app
const DEFAULT_TIMEOUT_MS = 300_000; // 5 min

function isEaddrinuse(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as NodeJS.ErrnoException).code === "EADDRINUSE";
}

export async function signIn(deps: SignInDeps, cfg: { port?: number; timeoutMs?: number }): Promise<{ jwt: string }> {
  const state = deps.randomState();
  const { verifier, challenge } = deps.pkce();
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let listened: { port: number; waitForCallback(): Promise<URL> };
  try {
    listened = await deps.loopback.listen(cfg.port ?? DEFAULT_PORT);
  } catch (e) {
    if (!isEaddrinuse(e)) throw e; // anything else is a real failure and must not be swallowed
    // Fixed port is taken (e.g. a stale/parallel instance). A random OS-assigned port is NOT a
    // usable fallback: the owner's Supabase project allowlists only the fixed port's redirect URI,
    // so a callback on any other port would just be rejected. Fail clearly instead of retrying into
    // a redirect that can never work.
    throw new Error("the sign-in port is busy - close any other BuildEx window and try again");
  }
  const { port, waitForCallback } = listened;
  const redirectUri = "http://127.0.0.1:" + port + "/auth/callback";

  try {
    deps.openBrowser(deps.supabase.authorizeUrl({ redirectUri, state, codeChallenge: challenge }));

    const startedAt = deps.now();
    const cb = await waitForCallback();
    if (deps.now() - startedAt >= timeoutMs) {
      throw new Error("sign-in timed out waiting for the browser redirect");
    }

    const err = cb.searchParams.get("error");
    if (err) throw new Error(`sign-in was denied: ${err}`);

    if (cb.searchParams.get("state") !== state) {
      // One-time-state / CSRF defense (invariant 7): a callback whose state does not match the one
      // this flow minted is never trusted, no matter how well-formed the rest of it looks.
      throw new Error("sign-in callback failed state validation");
    }

    const code = cb.searchParams.get("code");
    if (!code) throw new Error("sign-in callback is missing an authorization code");

    return await deps.supabase.exchangeCode({ code, codeVerifier: verifier, redirectUri });
  } finally {
    deps.loopback.close();
  }
}
