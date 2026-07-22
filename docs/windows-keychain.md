# Windows keychain backend

The `WindowsKeychain` (`apps/client/src/keychain/windows.ts`) is the win32 peer of the macOS
`SystemKeychain`. It closes the last functional Windows-parity gap: **secrets persist across a daemon
restart**, so a connector authorization or the per-machine git token survives exactly as it does on
macOS — never in a repo, config, log, or synced path (invariant 4).

## Why it exists

macOS shells to `/usr/bin/security` (generic passwords); Linux falls back to in-memory. On Windows,
`createKeychain({ mode: "auto" })` previously fell back to in-memory too — so every connector
authorization was lost when the daemon restarted. `demo.ts` and `daemon-entry.ts` already request
`keychainMode: "auto"`, so adding a win32 branch to `createKeychain` makes both the demo and the
packaged app persistent with no other wiring change.

## Design

Same `Keychain` contract as everywhere else — `get` / `set` / `delete`, nothing more (macOS has no
`deleteAll`/`getMany`, so neither does this; see *Deferred*). Storage is the **Windows Credential
Manager** (Generic credentials, `Persist = LOCAL_MACHINE`, DPAPI-encrypted by the OS), reached by
shelling to Windows PowerShell running an embedded `advapi32` P/Invoke (`CredReadW`/`CredWriteW`/
`CredDeleteW`).

- **Injected runner.** `WinCredRunner` is the seam (the peer of `SecurityRunner`): the keychain is unit
  tested with a fake in-memory Credential Manager, no PowerShell or OS vault touched.
- **Native `.exe`, plain spawn.** `powershell.exe` is a real executable, so `execFileSync` needs no
  `shell: true` (unlike the `npm`/`npx` `.cmd` shims that required the launch fix). Invoked via
  `-EncodedCommand` (UTF-16LE base64) so no quoting of the embedded script can go wrong.
- **Secret via STDIN.** The value is piped on stdin, never argv/env — it never appears on the process
  command line (a hardening over the macOS `security -w <argv>` path).
- **Per-workspace isolation.** The credential target is `` `${keychainService(workspace)}:${key}` `` —
  the same `sha256(workspace)` service prefix macOS uses (invariant 6).
- **Same-user readability (accepted risk).** Credential Manager entries are DPAPI-encrypted **at rest**,
  but carry no per-application ACL: any process running as the operator's own user can read every
  stored token silently (`cmdkey /list` plus a trivial `CredRead`). This is a weaker boundary than the
  macOS keychain, whose partition ACLs can prompt when an unfamiliar binary asks. Accepted under the
  single-operator-machine assumption, and strictly better than any file-based fallback — but it is a
  real difference between the platforms, not an implementation detail.

### Chunking (the one Windows-specific mechanism)

A Credential Manager blob caps at **2560 bytes** (verified: a 3000-byte write fails with `1783`); macOS
`security` has no such cap. To keep the same behaviour — store a value of any size — large values are
split:

- Stored values are single-line ASCII (`base64(secret)`, or a header), so stdin/stdout transport is
  trivial.
- **Small value (≤ 2000 chars):** stored directly in one credential — an atomic write, exactly like
  macOS. This is the common case.
- **Large value:** slices at `<target>#0…#n-1`, plus a header credential at `<target>` of the form
  `|BXK1|<n>:<sha8>` (a leading `|` is not in the base64 alphabet, so a header is never mistaken for a
  raw value).
- **Crash safety:** the header is the commit point, so **every prune happens before it** and slices are
  written before the header. `get` reassembles and verifies the checksum; a missing chunk or checksum
  mismatch returns `undefined` (the value degrades to "absent" → connector re-authorizes) — it **never
  returns a truncated or corrupt value**.

  The ordering is load-bearing, not stylistic. Credential Manager offers no transaction, so the process
  can die between any two operations. Pruning *after* the header would strand slices `#0…#n-1` — together
  the complete base64 secret — with no header left to describe them: the retry reads no header, computes
  a count of 0, prunes nothing, and a revoked token outlives its revocation. Pruning first means a crash
  leaves a header pointing at missing slices, which `get` already degrades to `undefined`, and a retry
  converges to a clean vault.

  Pruning also probes *past* the count the header records, because an interrupted write can leave slices
  the header never knew about (growing 4 chunks to 6 writes `#4`/`#5` while the header still says 4).

## Availability & fallback

`createKeychain` **probes** the win32 backend rather than checking for a file. Existence is not enough:
`powershell.exe` is present on every Windows machine, including ones where the helper can never run
(Constrained Language Mode blocks its `Add-Type`), and selecting such a vault made every read return
`undefined` — indistinguishable from "nothing stored".

The probe is a single read of a target that cannot exist. It exercises the whole path — PowerShell
start, `Add-Type` compile, `advapi32` P/Invoke — and a working helper answers `WIN_NOT_FOUND`. One
spawn, no write, so it cannot strand a canary of its own if the process dies mid-probe. It proves
readability, not writability; a write-denied vault still surfaces at connect time, where `set` throws.

If unavailable, `mode: "system"` throws (explicit opt-in must not silently degrade) and `mode: "auto"`
falls back to in-memory (never a plaintext file) — working for the session, forgotten on restart, but
honest about it.

### Contract parity with macOS

`get` returns `undefined` on *any* backend failure, matching `SystemKeychain.get`, so a machine whose
helper cannot run reads as "not connected" instead of hard-failing every connector route. `set` still
throws, so an explicit persistence failure stays loud, and `delete` tolerates a failing pre-read — a
broken read must never block a revocation. Every op is bounded by a timeout and spawned with
`windowsHide`, and always via the absolute System32 path (never a bare `powershell.exe`, which would
resolve through the CreateProcess search order — a binary-planting surface for a helper that receives
the secret on stdin).

## Validation

- Hermetic unit tests (`windows-keychain.test.ts`, fake runner): round-trip, empty value, missing key,
  base64-not-plaintext, update-or-add, delete-idempotent, per-workspace namespacing, chunk + reassemble,
  prune-on-shrink, torn-write / checksum-mismatch → undefined, factory win32 cases, malformed headers,
  the exact `CHUNK_LIMIT` boundary (1500 chars → exactly 2000 base64; 1501 → 2004), multi-byte unicode
  across chunk boundaries, macOS contract parity, the availability probe, and the spawn options.
- **Crash-window property test:** the runner is killed at *every* point of a delete, a shrinking set and
  a growing set, asserting the vault always converges to empty on retry — plus a direct assertion on the
  recorded operation sequence that every chunk delete precedes the header operation.
- The `advapi32` P/Invoke core and the full `WindowsKeychain` (including a 9000-char chunked value) were
  validated live against real Credential Manager, **read back in a separate process** — proving the
  cross-restart persistence guarantee on real hardware.

## Deferred

- **`getMany`** — a batched boot-reconnect read. macOS has none; it's a latency optimization with no
  measured need yet. Build + wire it in the connector OAuth sweep, where the reconnect loop is touched
  and boot time can be measured.

## Known limitations (shared with macOS — documented, not fixed here)

Because secrets live in the OS vault (not in any BuildEx file), two edges exist **on both macOS and
Windows**, and neither platform handles them today:

1. **Orphaned on uninstall.** Deleting the app / workspace does not remove its vault entries; neither
   platform has an uninstall hook. The Windows NSIS installer wires no vault cleanup, so uninstalling
   leaves every stored credential behind - see
   [Uninstall](guides/package-windows.md#uninstall) for what a Windows removal does and does not
   reclaim. macOS is worse here: removal is dragging the `.app` to the Trash, so no code runs at all.
2. **Path-reuse bleed.** The service id is `sha256(workspace path)`; a *new* company created at a
   deleted company's path inherits the old credentials — an invariant-6 edge.

A future cross-platform cleanup effort (a `deleteAll(servicePrefix)` primitive wired to company
teardown / uninstall, plus a defensive purge on fresh provisioning) would close both. It is out of scope
here because building it Windows-only would be asymmetric, and no teardown/uninstall caller exists yet.
