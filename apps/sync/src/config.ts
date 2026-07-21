// Process configuration for the sync service, parsed once at boot. Kept out of main.ts so the rules -
// what is required, what has a default, what is rejected - are unit-testable without spawning a
// process or binding a port. Fail fast and loudly: a service that boots with a weak service key is
// worse than one that refuses to boot, because the S2S surface is the only thing between the public
// internet and company creation.

export interface SyncConfig {
  serviceKey: string;
  publicBaseUrl: string;
  dataDir: string;
  port: number;
}

/** A shorter service key is a misconfiguration, not a valid deployment. */
export const MIN_SERVICE_KEY_LENGTH = 32;

export class ConfigError extends Error {}

export function readConfig(env: Record<string, string | undefined>): SyncConfig {
  const serviceKey = (env["BUILDEX_SERVICE_KEY"] ?? "").trim();
  if (!serviceKey) throw new ConfigError("BUILDEX_SERVICE_KEY is required");
  if (serviceKey.length < MIN_SERVICE_KEY_LENGTH) {
    throw new ConfigError(`BUILDEX_SERVICE_KEY must be at least ${MIN_SERVICE_KEY_LENGTH} characters`);
  }

  // Trailing slashes are stripped here so `${publicBaseUrl}/git/<repo>.git` can never double up.
  const rawBase = (env["BUILDEX_PUBLIC_BASE_URL"] ?? "").trim().replace(/\/+$/, "");
  if (!rawBase) throw new ConfigError("BUILDEX_PUBLIC_BASE_URL is required");
  let parsed: URL;
  try {
    parsed = new URL(rawBase);
  } catch {
    throw new ConfigError("BUILDEX_PUBLIC_BASE_URL must be an absolute URL");
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (parsed.protocol !== "https:" && !loopback) {
    throw new ConfigError("BUILDEX_PUBLIC_BASE_URL must be https (except on loopback)");
  }

  const dataDir = (env["BUILDEX_DATA_DIR"] ?? "/srv/buildex").trim();

  const rawPort = (env["PORT"] ?? "8080").trim();
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`PORT must be an integer between 0 and 65535, got "${rawPort}"`);
  }

  return { serviceKey, publicBaseUrl: rawBase, dataDir, port };
}
