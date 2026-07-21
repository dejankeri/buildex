// The Windows keychain backend (invariant 4) - the win32 peer of macOS SystemKeychain. Secrets live
// in the OS Credential Manager (Generic credentials, per-machine, DPAPI-encrypted by the OS), never in
// a repo/config/log/synced path - so a connector authorization survives a daemon restart, exactly as it
// does on macOS. Storage is reached by shelling to Windows PowerShell (a native .exe - plain spawn, no
// shell) running an embedded advapi32 P/Invoke (CredRead/Write/Delete), injected as WinCredRunner so the
// keychain stays hermetically testable with a fake, the same discipline SystemKeychain uses for the
// macOS `security` CLI.
//
// One thing Windows needs that macOS does not: CHUNKING. Credential Manager caps a credential blob at
// 2560 bytes (validated: a 3000-byte write fails), while macOS `security` stores any size. To keep the
// same behaviour - store any value - large values are split across sibling credentials with a header
// credential recording the count + a checksum. Small values (the common case) are stored directly in a
// single credential, an atomic write just like macOS.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Keychain } from "./keychain.js";

// Embedded PowerShell: env BXK_ACTION in {read,write,delete}, env BXK_TARGET = credential target.
//   write: value read from STDIN (never argv/env - keeps the secret off the process command line, a
//          hardening over the macOS `-w <argv>` path), stored as the CredentialBlob.
//   read : prints the stored value to STDOUT; exits 2 when the target is absent (ERROR_NOT_FOUND 1168).
//   delete: removes it; a missing target is not an error.
// Run via -EncodedCommand (UTF-16LE base64) so no quoting of this script can ever go wrong. Persist is
// LOCAL_MACHINE (per-machine token, invariant 6). This body is validated live against Credential Manager.
const PS_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BXKCred {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags; public uint Type;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
    [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount; public IntPtr Attributes;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
    [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
  }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredWriteW(ref CREDENTIAL c, uint flags);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredDeleteW(string target, uint type, uint flags);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr buffer);
}
'@
$TYPE_GENERIC = 1
$PERSIST_LOCAL_MACHINE = 2
$ERROR_NOT_FOUND = 1168
$action = $env:BXK_ACTION
$target = $env:BXK_TARGET
if ($action -eq 'write') {
  $value = [Console]::In.ReadToEnd()
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($value)
  $blob = [Runtime.InteropServices.Marshal]::AllocHGlobal([Math]::Max($bytes.Length,1))
  try {
    if ($bytes.Length -gt 0) { [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length) }
    $cred = New-Object BXKCred+CREDENTIAL
    $cred.Type = $TYPE_GENERIC
    $cred.TargetName = $target
    $cred.CredentialBlobSize = $bytes.Length
    $cred.CredentialBlob = $blob
    $cred.Persist = $PERSIST_LOCAL_MACHINE
    if (-not [BXKCred]::CredWriteW([ref]$cred, 0)) {
      throw "CredWrite failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
  } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($blob) }
  exit 0
}
elseif ($action -eq 'read') {
  $ptr = [IntPtr]::Zero
  if (-not [BXKCred]::CredReadW($target, $TYPE_GENERIC, 0, [ref]$ptr)) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($err -eq $ERROR_NOT_FOUND) { exit 2 }
    throw "CredRead failed: $err"
  }
  try {
    $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [Type][BXKCred+CREDENTIAL])
    $n = $cred.CredentialBlobSize
    $bytes = New-Object byte[] $n
    if ($n -gt 0) { [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $n) }
    [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($bytes))
  } finally { [BXKCred]::CredFree($ptr) }
  exit 0
}
elseif ($action -eq 'delete') {
  if (-not [BXKCred]::CredDeleteW($target, $TYPE_GENERIC, 0)) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($err -ne $ERROR_NOT_FOUND) { throw "CredDelete failed: $err" }
  }
  exit 0
}
else { throw "unknown action: $action" }`;

/** The runner exits with this code when a credential target does not exist (maps ERROR_NOT_FOUND). */
export const WIN_NOT_FOUND = 2;

/** A single Credential Manager operation. Injected so WindowsKeychain is unit-testable without the OS
 *  vault. `stdout` carries the stored value on a successful read; `status` mirrors the helper exit code
 *  (0 = ok, WIN_NOT_FOUND = absent, other = failure). */
export type WinCredRunner = (
  op:
    | { action: "read"; target: string }
    | { action: "write"; target: string; value: string }
    | { action: "delete"; target: string },
) => { status: number; stdout: string };

/** The canonical Windows PowerShell path (may not exist on a broken install - callers check). Windows
 *  PowerShell 5.1 is chosen over pwsh because it is always present. */
export function windowsPowerShellPath(): string {
  const sysRoot = process.env["SystemRoot"] ?? process.env["windir"] ?? "C:\\Windows";
  return join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** True when a real OS credential backend is reachable on this machine (the win32 peer of
 *  existsSync(SECURITY_BIN) on macOS - a lightweight presence check, not a functional probe). */
export function windowsKeychainAvailable(): boolean {
  return existsSync(windowsPowerShellPath());
}

/** The production runner: spawns Windows PowerShell (a native .exe, so plain spawn - no shell:true,
 *  unlike the .cmd shims) running the embedded advapi32 helper. The secret is piped via STDIN. */
export function defaultWinCredRunner(): WinCredRunner {
  const full = windowsPowerShellPath();
  const psExe = existsSync(full) ? full : "powershell.exe";
  const encoded = Buffer.from(PS_SCRIPT, "utf16le").toString("base64"); // -EncodedCommand wants UTF-16LE base64
  return (op) => {
    try {
      const stdout = execFileSync(psExe, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
        env: { ...process.env, BXK_ACTION: op.action, BXK_TARGET: op.target },
        ...(op.action === "write" ? { input: op.value } : {}),
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      });
      return { status: 0, stdout };
    } catch (e) {
      const err = e as { status?: number; stdout?: Buffer | string };
      return { status: typeof err.status === "number" ? err.status : 1, stdout: err.stdout?.toString() ?? "" };
    }
  };
}

// Chunking. A credential blob caps at 2560 bytes; we keep each stored value <= this margin. Stored
// values are single-line ASCII (base64 of the secret, or a header), so STDIN/STDOUT transport is
// trivial. A header is distinguishable from a raw value by its leading '|', which base64 never produces.
const CHUNK_LIMIT = 2000;
const HEADER_PREFIX = "|BXK1|"; // header form: |BXK1|<chunkCount>:<sha8(base64)>

const encode = (value: string): string => Buffer.from(value, "utf8").toString("base64");
const decode = (b64: string): string => Buffer.from(b64, "base64").toString("utf8");
const sha8 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 8);

/** Persistent, Credential-Manager-backed keychain: the win32 peer of SystemKeychain. Same Keychain
 *  contract (get/set/delete); values of any size via transparent chunking; secrets never leave the OS
 *  vault. Per-workspace isolation comes from the service prefix (invariant 6). */
export class WindowsKeychain implements Keychain {
  constructor(
    private readonly service: string,
    private readonly run: WinCredRunner = defaultWinCredRunner(),
  ) {}

  private target(key: string): string {
    return `${this.service}:${key}`;
  }

  /** Raw single-credential read: undefined when absent, throws on a real failure. */
  private readRaw(target: string): string | undefined {
    const r = this.run({ action: "read", target });
    if (r.status === WIN_NOT_FOUND) return undefined;
    if (r.status !== 0) throw new Error(`keychain read failed for "${target}" (exit ${r.status})`);
    return r.stdout;
  }

  private writeRaw(target: string, value: string): void {
    const r = this.run({ action: "write", target, value });
    if (r.status !== 0) throw new Error(`keychain write failed for "${target}" (exit ${r.status})`);
  }

  private deleteRaw(target: string): void {
    this.run({ action: "delete", target }); // a missing target is not an error (helper exits 0)
  }

  /** How many chunk siblings the CURRENT stored value has (0 when absent or stored raw) - read before a
   *  set/delete so stale chunks from a previous, longer value are pruned. */
  private currentChunkCount(target: string): number {
    const head = this.readRaw(target);
    if (head === undefined || !head.startsWith(HEADER_PREFIX)) return 0;
    return parseHeader(head)?.n ?? 0;
  }

  /** Never throws: if the backend is failing we cannot enumerate, so stop probing rather than turn a
   *  cleanup into an exception. */
  private chunkExists(target: string): boolean {
    try {
      return this.readRaw(target) !== undefined;
    } catch {
      return false;
    }
  }

  /** Delete siblings `from`..`upto-1`, then keep going while more exist - an interrupted write can
   *  leave siblings the current header never recorded (growing 4 chunks to 6 writes #4/#5 while the
   *  header still says 4). Costs one extra read per prune. */
  private pruneChunks(target: string, from: number, upto: number): void {
    for (let k = from; k < upto; k++) this.deleteRaw(`${target}#${k}`);
    for (let k = Math.max(from, upto); this.chunkExists(`${target}#${k}`); k++) {
      this.deleteRaw(`${target}#${k}`);
    }
  }

  // ORDERING INVARIANT - never move a prune after the header write/delete, however much tidier it
  // looks. Credential Manager gives us no transaction and the header is the commit point. Pruning
  // first means a crash leaves a header pointing at missing chunks, which get() already degrades to
  // `undefined`, and a retry converges. Pruning last strands chunks #0..#n-1 - together the COMPLETE
  // base64 secret - with no header left to describe them, so the retry computes oldN = 0 and a
  // revoked token stays readable by any same-user process. Verified: they decode back to the original.

  get(key: string): string | undefined {
    const target = this.target(key);
    const head = this.readRaw(target);
    if (head === undefined) return undefined;
    if (!head.startsWith(HEADER_PREFIX)) return decode(head); // raw value (the common case)
    const meta = parseHeader(head);
    if (!meta) return undefined; // malformed header
    let b64 = "";
    for (let k = 0; k < meta.n; k++) {
      const part = this.readRaw(`${target}#${k}`);
      if (part === undefined) return undefined; // a missing chunk -> torn write, degrade to absent
      b64 += part;
    }
    if (sha8(b64) !== meta.sha) return undefined; // checksum mismatch -> torn/corrupt, never return it
    return decode(b64);
  }

  set(key: string, value: string): void {
    const target = this.target(key);
    const b64 = encode(value);
    const oldN = this.currentChunkCount(target);
    if (b64.length <= CHUNK_LIMIT) {
      this.pruneChunks(target, 0, oldN);
      this.writeRaw(target, b64); // single atomic credential, exactly like macOS - the commit
      return;
    }
    const parts: string[] = [];
    for (let i = 0; i < b64.length; i += CHUNK_LIMIT) parts.push(b64.slice(i, i + CHUNK_LIMIT));
    this.pruneChunks(target, parts.length, oldN);
    for (let k = 0; k < parts.length; k++) this.writeRaw(`${target}#${k}`, parts[k]!);
    this.writeRaw(target, `${HEADER_PREFIX}${parts.length}:${sha8(b64)}`); // header last = the commit
  }

  delete(key: string): void {
    const target = this.target(key);
    const oldN = this.currentChunkCount(target);
    this.pruneChunks(target, 0, oldN);
    this.deleteRaw(target); // header last = the commit
  }
}

/** Parse a `|BXK1|<n>:<sha8>` header. Returns undefined for a malformed one (treated as no value). */
function parseHeader(head: string): { n: number; sha: string } | undefined {
  const meta = head.slice(HEADER_PREFIX.length);
  const sep = meta.indexOf(":");
  if (sep <= 0) return undefined;
  const n = Number(meta.slice(0, sep));
  const sha = meta.slice(sep + 1);
  if (!Number.isInteger(n) || n <= 0 || sha.length === 0) return undefined;
  return { n, sha };
}
