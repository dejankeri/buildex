// runDeterministic's CLI contract, extracted so it is testable (the CLI module runs main() on
// import). Three lanes: sandbox (default - mint/pin/destroy via the pack's sandbox face), local
// (--mcp-url - pin a caller-supplied url + key directly, no endpoints needed), and --no-sandbox
// (no pin at all - plumbing/drive only).

export interface Args {
  pack: string;
  sandbox: boolean;
  agent: boolean;
  /** Set = the local lane: pin this url with the key from env, skip mint/destroy. */
  mcpUrl: string | undefined;
  /** Override the built-in smoke prompt for this run's drive case. */
  prompt: string | undefined;
}

const VALID_FLAGS = ["--pack", "--mcp-url", "--prompt", "--no-sandbox", "--no-agent"] as const;

/** A flag's value, with the forgotten-value trap closed: the token after `--pack`/`--prompt` must
 *  not itself be a flag, or a typo'd invocation silently misparses (e.g. `--prompt --no-sandbox`
 *  would otherwise drive the agent with the literal prompt "--no-sandbox" AND leave the sandbox
 *  lane on). */
function flagValue(flag: string, v: string | undefined): string {
  if (!v || v.startsWith("--")) throw new Error(`${flag} needs a value${v ? ` (got the flag ${v})` : ""}`);
  return v;
}

/** The local lane exists for locally running providers, so http is allowed on loopback hosts ONLY
 *  - a key headed anywhere else still travels https. Exact hostname match: "localhost.evil.com"
 *  does not qualify; `[::1]` is IPv6 loopback. Throws with the flag's name so a bad value reads as
 *  a usage error. */
function checkMcpUrl(raw: string): string {
  // "localhost:3010/mcp" parses as protocol "localhost:" - catch the missing scheme by name.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    throw new Error(`--mcp-url needs a scheme (http:// or https://): ${raw}`);
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`--mcp-url is not a valid url: ${raw}`);
  }
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
    throw new Error(`--mcp-url must be https, or http on localhost/127.0.0.1/[::1] only: ${raw}`);
  }
  return raw;
}

export function parseArgs(argv: string[]): Args {
  let pack: string | undefined;
  let mcpUrl: string | undefined;
  let prompt: string | undefined;
  let noSandbox = false;
  let agent = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pack") pack = flagValue("--pack", argv[++i]);
    else if (a === "--mcp-url") mcpUrl = checkMcpUrl(flagValue("--mcp-url", argv[++i]));
    else if (a === "--prompt") prompt = flagValue("--prompt", argv[++i]);
    else if (a === "--no-sandbox") noSandbox = true;
    else if (a === "--no-agent") agent = false;
    else throw new Error(`unknown flag: ${a} (valid: ${VALID_FLAGS.join(", ")})`);
  }
  if (!pack) throw new Error("usage: runDeterministic.ts --pack <id> [--mcp-url <url>] [--prompt <text>] [--no-sandbox] [--no-agent]");
  if (mcpUrl !== undefined && noSandbox) {
    throw new Error("--mcp-url already skips the sandbox lane - drop --no-sandbox");
  }
  return { pack, sandbox: mcpUrl === undefined && !noSandbox, agent, mcpUrl, prompt };
}

// --- proof.ts's CLI contract -------------------------------------------------------------------
// The proof track always drives and always needs a provider lane, so unlike the deterministic
// CLI there is no --no-sandbox/--no-agent/--prompt here: sandbox-vs-local is decided purely by
// --mcp-url's presence downstream, in the composition step (not parsed here).

export interface ProofArgs {
  pack: string;
  /** Set = the local lane (pin this url directly); undefined = mint a sandbox. */
  mcpUrl: string | undefined;
  /** Number of cases to draw for this run. Integer 1..20, default 5. */
  cases: number;
  /** Path to a prior run's surface.json to diff surface drift against. No existence check here -
   *  parsing stays pure; proof.ts checks the file exists before reading it. */
  baseline: string | undefined;
}

const PROOF_VALID_FLAGS = ["--pack", "--mcp-url", "--cases", "--baseline"] as const;

const DEFAULT_CASES = 5;
const MIN_CASES = 1;
const MAX_CASES = 20;

/** `--cases` must be an integer in [1, 20]: `Number()` (not `parseInt`) so trailing garbage like
 *  "5abc" is rejected rather than silently truncated, and `Number.isInteger` so "2.5" is rejected
 *  rather than floored. */
function parseCases(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_CASES || n > MAX_CASES) {
    throw new Error(`--cases must be an integer ${MIN_CASES}..${MAX_CASES}: ${raw}`);
  }
  return n;
}

export function parseProofArgs(argv: string[]): ProofArgs {
  let pack: string | undefined;
  let mcpUrl: string | undefined;
  let cases = DEFAULT_CASES;
  let baseline: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pack") pack = flagValue("--pack", argv[++i]);
    else if (a === "--mcp-url") mcpUrl = checkMcpUrl(flagValue("--mcp-url", argv[++i]));
    else if (a === "--cases") cases = parseCases(flagValue("--cases", argv[++i]));
    else if (a === "--baseline") baseline = flagValue("--baseline", argv[++i]);
    else throw new Error(`unknown flag: ${a} (valid: ${PROOF_VALID_FLAGS.join(", ")})`);
  }
  if (!pack) throw new Error("usage: proof.ts --pack <id> [--mcp-url <url>] [--cases <1-20>] [--baseline <path>]");
  return { pack, mcpUrl, cases, baseline };
}
