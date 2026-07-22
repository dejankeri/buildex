// SIGN-IN JWT INVARIANT SUITE [release-gate:signin-jwt]: a forged, expired, or wrong-issuer JWT
// must never mint a machine token. This drives BOTH layers Task 1 and Task 6 built - `verifyJwt`
// directly (the pure claim/signature check) and the real `POST /session` handler wired exactly the
// way server.ts wires it (verifyJwt + a JWKS resolver), never a mocked "always fail" verifySession -
// so a regression in either layer, or in how they're wired together, fails this suite.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import type { KeyObject, JsonWebKey } from "node:crypto";
import { ControlPlaneStore } from "../store/store.js";
import { EmbeddedGitService } from "../git/service.js";
import { ProvisioningService } from "../provisioning/service.js";
import { ScheduleStore } from "../automations/schedule-store.js";
import { createApp, type Handler } from "../http/app.js";
import { verifyJwt, JwtError } from "../auth/jwt-verify.js";
import type { JwkResolver, VerifyConfig } from "../auth/jwt-verify.js";

const ISSUER = "https://project.supabase.co/auth/v1";
const AUDIENCE = "authenticated";
const NOW_MS = 1_700_000_000_000; // fixed clock for deterministic exp tests
const now = () => NOW_MS;
const CONFIG: VerifyConfig = { issuer: ISSUER, audience: AUDIENCE };
const SERVER_KID = "server-key-1";

function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64url");
}

/**
 * Build+sign a JWT with `privateKey`, tagged with `SERVER_KID` by default (so a token signed by a
 * key OTHER than the server's still claims to be the server's kid - that's what makes the forged
 * case meaningful: it's rejected on signature, not on an unknown kid). Kept local rather than
 * imported from jwt-verify.test.ts so this release gate stays hermetic and self-contained.
 */
function makeToken(privateKey: KeyObject, opts: { kid?: string; payload?: Record<string, unknown> } = {}): string {
  const kid = opts.kid ?? SERVER_KID;
  const header = { alg: "RS256", typ: "JWT", kid };
  const payload = {
    sub: "user-1",
    iss: ISSUER,
    aud: AUDIENCE,
    exp: Math.floor(NOW_MS / 1000) + 3600,
    iat: Math.floor(NOW_MS / 1000) - 60,
    ...opts.payload,
  };
  const headerSeg = b64url(JSON.stringify(header));
  const payloadSeg = b64url(JSON.stringify(payload));
  const signingInput = `${headerSeg}.${payloadSeg}`;
  const sig = cryptoSign("RSA-SHA256", Buffer.from(signingInput), privateKey);
  return `${signingInput}.${b64url(sig)}`;
}

function generateRsaPair() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  return { privateKey, jwk };
}

describe("SIGN-IN JWT INVARIANT SUITE [release-gate:signin-jwt]: a forged/expired/wrong-issuer JWT never mints a machine token", () => {
  // The server's real signing key - what the JWKS resolver advertises for SERVER_KID and what
  // verifyJwt trusts. The forged case signs with a DIFFERENT key but keeps this kid, so if the
  // signature check were ever skipped/weakened the forged token would otherwise sail straight through.
  const server = generateRsaPair();
  const resolver: JwkResolver = {
    resolve: async (kid: string) => {
      if (kid !== SERVER_KID) throw new JwtError("unknown key id");
      return { ...server.jwk, kid: SERVER_KID };
    },
  };

  let dir: string;
  let store: ControlPlaneStore;
  let schedules: ScheduleStore;
  let git: EmbeddedGitService;
  let app: Handler;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "buildex-signin-jwt-"));
    store = new ControlPlaneStore(join(dir, "control.db"));
    git = new EmbeddedGitService({ reposRoot: join(dir, "repos") });
    const provisioning = new ProvisioningService({ store, git, idFactory: () => "m1" });
    await provisioning.ensureCoreRepo();
    schedules = new ScheduleStore(join(dir, "schedules.db"));
    // Wired exactly like server.ts's createServices(): verifyJwt + a JWKS resolver behind
    // verifySession, never a mocked always-succeed/always-fail stand-in.
    app = createApp({
      store,
      provisioning,
      git,
      schedules,
      serviceKey: "svc-key",
      publicBaseUrl: "https://sync.test",
      verifySession: async (jwt: string) => {
        const claims = await verifyJwt(jwt, { keys: resolver, now, config: CONFIG });
        return { sub: claims.sub, email: claims.email };
      },
    });
  });

  afterEach(() => {
    store.close();
    schedules.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const session = (jwt: string) =>
    new Request("https://sync.test/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jwt, machineName: "attacker-laptop" }),
    });

  /** Both layers must reject `jwt`, and neither may leave any trace of `sub` behind. */
  async function assertNeverMints(jwt: string, sub: string): Promise<void> {
    // Layer 1 (Task 1): verifyJwt itself rejects with JwtError.
    await expect(verifyJwt(jwt, { keys: resolver, now, config: CONFIG })).rejects.toThrow(JwtError);

    // Layer 2 (Task 6): the real /session route answers 401 and returns no credential.
    const res = await app(session(jwt));
    expect(res.status).toBe(401);
    const responseBody = (await res.json()) as Record<string, unknown>;
    expect(responseBody).not.toHaveProperty("machineToken");
    expect(responseBody).not.toHaveProperty("refreshToken");

    // No company/operator was ever provisioned for the rejected sub.
    expect(store.findOperatorBySupabaseSub(sub)).toBeNull();
  }

  it("rejects a token FORGED with a different key than the JWKS advertises for that kid", async () => {
    const forger = generateRsaPair();
    const forged = makeToken(forger.privateKey, { payload: { sub: "attacker-forged" } });
    await assertNeverMints(forged, "attacker-forged");
  });

  it("rejects an EXPIRED token that is otherwise correctly signed by the real key", async () => {
    const expired = makeToken(server.privateKey, {
      payload: { sub: "attacker-expired", exp: Math.floor(NOW_MS / 1000) - 10 },
    });
    await assertNeverMints(expired, "attacker-expired");
  });

  it("rejects a WRONG-ISSUER token that is otherwise correctly signed by the real key", async () => {
    const wrongIssuer = makeToken(server.privateKey, {
      payload: { sub: "attacker-wrong-issuer", iss: "https://evil.example.com" },
    });
    await assertNeverMints(wrongIssuer, "attacker-wrong-issuer");
  });

  it("sanity: a genuinely valid token IS accepted - proves the harness isn't rejecting everything", async () => {
    const valid = makeToken(server.privateKey, { payload: { sub: "legit-user" } });

    const claims = await verifyJwt(valid, { keys: resolver, now, config: CONFIG });
    expect(claims.sub).toBe("legit-user");

    const res = await app(session(valid));
    expect(res.status).toBe(200);
    const creds = (await res.json()) as { machineToken: string };
    expect(creds.machineToken).toBeTruthy();
    expect(store.findOperatorBySupabaseSub("legit-user")).not.toBeNull();
  });
});
