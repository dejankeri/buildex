// Why this exists: on Windows an npm-installed CLI is a `.cmd` shim, not an `.exe`. libuv's PATH
// probe (what `spawn("claude")` uses under the hood) only ever tries `.com` and `.exe`, so an
// operator who ran `npm i -g @anthropic-ai/claude-code` gets ENOENT from BuildEx while `claude` runs
// fine in their own terminal - and `detect()` reports the agent as unavailable (node-spawn settles
// 127, claude-driver maps any non-zero to `available: false`).
//
// `shell: true` is NOT an acceptable fix here. `ClaudeCodeDriver.buildArgs` puts prompt text into
// argv (`["-p", prompt, ...]`); routing that through cmd.exe would let `&`, `|`, `>` and `^` in a
// prompt become shell operators - a command-injection surface on the product's most attacker-adjacent
// input. So we resolve the shim ourselves and spawn the real executable directly, never a shell.
//
// Contract: return a replacement command+argv only when we are CONFIDENT it is better; otherwise
// return null and let the caller keep today's bare-spawn semantics. Never worse, never a shell.
//
// Pure and injectable (PATH, PATHEXT, exists, readFile) so it is hermetically testable on every OS -
// the logic is Windows *semantics*, not a Windows *runtime*, so the suite covers it on Linux/macOS
// CI too. Uses `path.win32` throughout for the same reason.
import { win32 } from "node:path";

export interface Win32ResolveDeps {
  /** The PATH to search (process.env.PATH). */
  path?: string | undefined;
  /** PATHEXT (process.env.PATHEXT); the extension search order Windows itself honours. */
  pathExt?: string | undefined;
  /** Existence probe - injected so tests need no real filesystem. */
  exists: (p: string) => boolean;
  /** Read a shim's text - injected for the same reason. Throwing is treated as "undecodable". */
  readFile: (p: string) => string;
}

/** A command the caller can hand straight to `spawn()` with no shell. */
export interface ResolvedCommand {
  command: string;
  args: string[];
}

/** Windows' own default when PATHEXT is unset. `.COM`/`.EXE` lead, which is why a real binary
 *  naturally beats a shim of the same name inside one directory. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";

/** Extensions `spawn()` can launch directly, with no interpreter and no shell. */
const DIRECTLY_SPAWNABLE = new Set([".com", ".exe"]);
/** Extensions that are batch shims - only cmd.exe can run these, so we must decode instead. */
const SHIM_EXTS = new Set([".bat", ".cmd"]);

/** The wrapped script inside an npm cmd-shim, in both shapes npm has emitted:
 *  `"%dp0%\…\cli.js"` (current) and `"%~dp0\…\cli.js"` (legacy). Anchored on the `dp0` prefix and a
 *  `.js` tail so the shim's other quoted paths (notably `"%dp0%\node.exe"`) can never match. */
const SHIM_TARGET = /"%~?dp0%?[\\/]([^"]+?\.js)"/i;

/** Split a `;`-delimited Windows list, dropping empties (a trailing `;` is common and harmless). */
function splitList(value: string | undefined): string[] {
  return (value ?? "").split(";").filter((s) => s.trim().length > 0);
}

/** Find `node.exe` the way the shim itself does: a sibling next to the shim wins (npm writes that
 *  check into every shim), otherwise the first one on PATH. Null when there is no node to run. */
function findNode(shimDir: string, dirs: string[], deps: Win32ResolveDeps): string | null {
  const sibling = win32.join(shimDir, "node.exe");
  if (deps.exists(sibling)) return sibling;
  for (const dir of dirs) {
    const candidate = win32.join(dir, "node.exe");
    if (deps.exists(candidate)) return candidate;
  }
  return null;
}

/** Turn `<dir>\claude.cmd` into `node.exe <wrapped cli.js>`, or null if we cannot read the shim,
 *  cannot recognise its shape, or cannot find a node to run it with. */
function decodeShim(
  shimPath: string,
  dirs: string[],
  args: string[],
  deps: Win32ResolveDeps,
): ResolvedCommand | null {
  let text: string;
  try {
    text = deps.readFile(shimPath);
  } catch {
    return null; // unreadable shim - fall back rather than guess
  }
  const match = SHIM_TARGET.exec(text);
  if (!match?.[1]) return null; // not an npm-shaped shim (a hand-written .cmd, a wrapper, …)

  const shimDir = win32.dirname(shimPath);
  const node = findNode(shimDir, dirs, deps);
  if (!node) return null; // nothing to interpret the script with

  // Deliberately NOT probing the .js for existence: the shim is authoritative about where it points,
  // and if the file is genuinely missing node fails exactly as the shim would have - which the
  // existing non-zero-exit path already reports as "unavailable".
  return { command: node, args: [win32.join(shimDir, match[1]), ...args] };
}

/**
 * Resolve a bare command name to something `spawn()` can launch on Windows without a shell.
 *
 * Follows Windows' own search semantics: directories in PATH order, and within each directory the
 * PATHEXT order (so `claude.exe` beats `claude.cmd` in one dir, but an earlier dir's `claude.cmd`
 * beats a later dir's `claude.exe` - exactly what the OS does).
 *
 * Returns null - meaning "caller, keep doing what you did before" - when the command is an explicit
 * path, is not found, or resolves to a shim we cannot confidently decode.
 */
export function resolveWin32Command(
  command: string,
  args: string[],
  deps: Win32ResolveDeps,
): ResolvedCommand | null {
  // An explicit path is the caller's own decision; never second-guess it.
  if (command.includes("\\") || command.includes("/")) return null;

  const dirs = splitList(deps.path);
  if (dirs.length === 0) return null;

  const exts = splitList(deps.pathExt ?? DEFAULT_PATHEXT).map((e) =>
    (e.startsWith(".") ? e : `.${e}`).toLowerCase(),
  );

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = win32.join(dir, command + ext);
      if (!deps.exists(candidate)) continue;
      if (DIRECTLY_SPAWNABLE.has(ext)) return { command: candidate, args };
      if (SHIM_EXTS.has(ext)) return decodeShim(candidate, dirs, args, deps);
      // Anything else (.vbs, .js, …) needs an interpreter we are not willing to pick. Windows would
      // have run it via the shell; we keep looking, and fall back if nothing better turns up.
    }
  }
  return null;
}
