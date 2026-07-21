import { describe, it, expect } from "vitest";
import { win32 } from "node:path";
import { resolveWin32Command, type Win32ResolveDeps } from "./win32-resolve.js";

// A byte-shaped npm cmd-shim, as `npm i -g @anthropic-ai/claude-code` writes it on Windows.
const NPM_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
].join("\r\n");

// The older shim shape npm emitted for years - same job, `%~dp0` instead of the `dp0` variable.
const LEGACY_SHIM = '@"%~dp0\\node_modules\\.bin\\claude\\cli.js" %*';

const PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.JS";

/** Hermetic deps over a virtual filesystem: a set of existing paths + a shim-text map. */
function deps(files: Record<string, string>, pathDirs: string[], pathExt = PATHEXT): Win32ResolveDeps {
  const present = new Set(Object.keys(files).map((f) => f.toLowerCase()));
  return {
    path: pathDirs.join(";"),
    pathExt,
    exists: (p) => present.has(p.toLowerCase()),
    readFile: (p) => {
      const hit = Object.entries(files).find(([k]) => k.toLowerCase() === p.toLowerCase());
      if (!hit) throw new Error(`ENOENT ${p}`);
      return hit[1];
    },
  };
}

const D1 = "C:\\Users\\op\\AppData\\Roaming\\npm";
const D2 = "C:\\Program Files\\claude";
const NODEDIR = "C:\\Program Files\\nodejs";

describe("resolveWin32Command - make a .cmd-shimmed CLI spawnable without a shell", () => {
  it("resolves a bare name to a directly-spawnable .exe on PATH", () => {
    const d = deps({ [win32.join(D2, "claude.exe")]: "" }, [D1, D2]);
    expect(resolveWin32Command("claude", ["--version"], d)).toEqual({
      command: win32.join(D2, "claude.exe"),
      args: ["--version"],
    });
  });

  it("honours PATHEXT order within a directory (.EXE beats .CMD in the same dir)", () => {
    const d = deps(
      { [win32.join(D1, "claude.exe")]: "", [win32.join(D1, "claude.cmd")]: NPM_SHIM },
      [D1],
    );
    expect(resolveWin32Command("claude", [], d)?.command).toBe(win32.join(D1, "claude.exe"));
  });

  it("searches PATH directories in order - an earlier dir's .cmd beats a later dir's .exe", () => {
    // This is real Windows semantics: the OS exhausts PATHEXT within dir 1 before trying dir 2.
    const d = deps(
      {
        [win32.join(D1, "claude.cmd")]: NPM_SHIM,
        [win32.join(D2, "claude.exe")]: "",
        [win32.join(NODEDIR, "node.exe")]: "",
      },
      [D1, D2, NODEDIR],
    );
    const got = resolveWin32Command("claude", [], d);
    expect(got?.command).toBe(win32.join(NODEDIR, "node.exe"));
  });

  it("decodes an npm cmd-shim into node.exe + the wrapped cli.js, preserving args in order", () => {
    const d = deps(
      { [win32.join(D1, "claude.cmd")]: NPM_SHIM, [win32.join(NODEDIR, "node.exe")]: "" },
      [D1, NODEDIR],
    );
    expect(resolveWin32Command("claude", ["-p", "hello", "--verbose"], d)).toEqual({
      command: win32.join(NODEDIR, "node.exe"),
      args: [
        win32.join(D1, "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
        "-p",
        "hello",
        "--verbose",
      ],
    });
  });

  it("decodes the legacy %~dp0 shim shape too", () => {
    const d = deps(
      { [win32.join(D1, "claude.cmd")]: LEGACY_SHIM, [win32.join(NODEDIR, "node.exe")]: "" },
      [D1, NODEDIR],
    );
    expect(resolveWin32Command("claude", [], d)?.args[0]).toBe(
      win32.join(D1, "node_modules", ".bin", "claude", "cli.js"),
    );
  });

  it("prefers a node.exe sitting beside the shim, exactly as the shim itself does", () => {
    const d = deps(
      {
        [win32.join(D1, "claude.cmd")]: NPM_SHIM,
        [win32.join(D1, "node.exe")]: "", // sibling wins
        [win32.join(NODEDIR, "node.exe")]: "",
      },
      [D1, NODEDIR],
    );
    expect(resolveWin32Command("claude", [], d)?.command).toBe(win32.join(D1, "node.exe"));
  });

  // --- the "never worse, never a shell" contract ------------------------------------------------

  it("returns null for an undecodable .cmd so the caller keeps today's bare-spawn semantics", () => {
    const d = deps({ [win32.join(D1, "claude.cmd")]: "@echo something else entirely\r\n" }, [D1]);
    expect(resolveWin32Command("claude", [], d)).toBeNull();
  });

  it("returns null when a decodable shim exists but no node.exe can be found", () => {
    const d = deps({ [win32.join(D1, "claude.cmd")]: NPM_SHIM }, [D1]);
    expect(resolveWin32Command("claude", [], d)).toBeNull();
  });

  it("returns null when the command is nowhere on PATH", () => {
    expect(resolveWin32Command("claude", [], deps({}, [D1, D2]))).toBeNull();
  });

  it("returns null for a command already given as an explicit path (caller knows best)", () => {
    const explicit = win32.join(D2, "claude.exe");
    expect(resolveWin32Command(explicit, [], deps({ [explicit]: "" }, [D1]))).toBeNull();
  });

  it("returns null on an empty PATH rather than inventing a location", () => {
    expect(resolveWin32Command("claude", [], deps({}, []))).toBeNull();
  });

  // --- SECURITY: the whole reason this module exists instead of `shell: true` --------------------

  it("never routes through a shell - prompt text stays a verbatim argv element", () => {
    // buildArgs() puts operator/agent-authored prompt text in argv. Under `shell: true` this string
    // would be parsed by cmd.exe (&, |, >, ^ are all operators there) - a command-injection surface.
    // The resolver must hand back an executable + argv, never a shell invocation.
    const nasty = 'hello & calc.exe | whoami > C:\\pwned.txt ^& echo "x"';
    const d = deps(
      { [win32.join(D1, "claude.cmd")]: NPM_SHIM, [win32.join(NODEDIR, "node.exe")]: "" },
      [D1, NODEDIR],
    );
    const got = resolveWin32Command("claude", ["-p", nasty], d);
    expect(got).not.toBeNull();
    expect(got!.command.toLowerCase()).toMatch(/node\.exe$/);
    expect(got!.command.toLowerCase()).not.toMatch(/cmd\.exe$|powershell|\.bat$|\.cmd$/);
    expect(got!.args).toContain(nasty); // byte-identical, never re-parsed or escaped
  });
});
