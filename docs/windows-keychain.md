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
- **Crash safety:** slices are written first, the header last (the commit point). `get` reassembles and
  verifies the checksum; a missing chunk or checksum mismatch returns `undefined` (the value degrades to
  "absent" → connector re-authorizes) — it **never returns a truncated or corrupt value**. `set`/`delete`
  prune now-surplus chunk siblings.

## Availability & fallback

`createKeychain` treats win32 as available when a runner is injected (tests) or `powershell.exe` exists
(the lightweight peer of macOS's `existsSync(SECURITY_BIN)` — no functional probe). If unavailable,
`mode: "system"` throws (explicit opt-in must not silently degrade) and `mode: "auto"` falls back to
in-memory (never a plaintext file).

## Validation

- Hermetic unit tests (`windows-keychain.test.ts`, fake runner): round-trip, empty value, missing key,
  base64-not-plaintext, update-or-add, delete-idempotent, per-workspace namespacing, chunk + reassemble,
  prune-on-shrink, torn-write / checksum-mismatch → undefined, factory win32 cases.
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

1. **Orphaned on uninstall.** Deleting the app / workspace does not remove its vault entries; there is no
   uninstall hook (and on Windows no installer yet).
2. **Path-reuse bleed.** The service id is `sha256(workspace path)`; a *new* company created at a
   deleted company's path inherits the old credentials — an invariant-6 edge.

A future cross-platform cleanup effort (a `deleteAll(servicePrefix)` primitive wired to company
teardown / uninstall, plus a defensive purge on fresh provisioning) would close both. It is out of scope
here because building it Windows-only would be asymmetric, and no teardown/uninstall caller exists yet.
