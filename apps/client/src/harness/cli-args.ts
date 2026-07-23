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
