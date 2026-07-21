import { describe, it, expect } from "vitest";
import { WindowsKeychain, WIN_NOT_FOUND, type WinCredRunner } from "./windows.js";
import { createKeychain } from "./keychain.js";

// A stateful fake of Windows Credential Manager: an in-memory (target -> stored value) map that mirrors
// the runner contract - a read of an absent target returns WIN_NOT_FOUND, everything else exit 0. This
// lets the whole keychain (including chunking) be tested hermetically, with no PowerShell or OS vault.
function fakeCredManager() {
  const store = new Map<string, string>();
  const run: WinCredRunner = (op) => {
    switch (op.action) {
      case "write":
        store.set(op.target, op.value);
        return { status: 0, stdout: "" };
      case "read": {
        const v = store.get(op.target);
        return v === undefined ? { status: WIN_NOT_FOUND, stdout: "" } : { status: 0, stdout: v };
      }
      case "delete":
        store.delete(op.target);
        return { status: 0, stdout: "" };
    }
  };
  return { run, store };
}

const chunkKeys = (store: Map<string, string>, prefix: string) =>
  [...store.keys()].filter((t) => t.startsWith(`${prefix}#`));

describe("WindowsKeychain - Credential Manager persistence", () => {
  it("round-trips a value (set -> get) via the injected runner", () => {
    const { run } = fakeCredManager();
    const kc = new WindowsKeychain("buildex-test", run);
    kc.set("connector:gmail:oauth:tokens", JSON.stringify({ accessToken: "AT", refreshToken: "RT" }));
    expect(JSON.parse(kc.get("connector:gmail:oauth:tokens")!)).toMatchObject({ accessToken: "AT" });
  });

  it("returns undefined for a missing key (WIN_NOT_FOUND)", () => {
    const { run } = fakeCredManager();
    expect(new WindowsKeychain("buildex-test", run).get("nope")).toBeUndefined();
  });

  it("round-trips an empty-string value (distinct from a missing key)", () => {
    const { run } = fakeCredManager();
    const kc = new WindowsKeychain("buildex-test", run);
    kc.set("k", "");
    expect(kc.get("k")).toBe("");
    expect(kc.get("missing")).toBeUndefined();
  });

  it("stores the value base64-encoded, never as plaintext", () => {
    const { run, store } = fakeCredManager();
    new WindowsKeychain("buildex-test", run).set("k", "super-secret-token");
    const stored = [...store.values()][0]!;
    expect(stored).not.toContain("super-secret-token");
    expect(Buffer.from(stored, "base64").toString("utf8")).toBe("super-secret-token");
  });

  it("update-or-add: setting the same key twice keeps the latest", () => {
    const { run } = fakeCredManager();
    const kc = new WindowsKeychain("buildex-test", run);
    kc.set("k", "first");
    kc.set("k", "second");
    expect(kc.get("k")).toBe("second");
  });

  it("delete removes it; deleting a missing key does not throw", () => {
    const { run } = fakeCredManager();
    const kc = new WindowsKeychain("buildex-test", run);
    kc.set("k", "v");
    kc.delete("k");
    expect(kc.get("k")).toBeUndefined();
    expect(() => kc.delete("k")).not.toThrow();
  });

  it("namespaces per workspace (same key, different services don't collide)", () => {
    const { run, store } = fakeCredManager();
    new WindowsKeychain("buildex-alpha", run).set("connector:gmail", "a");
    new WindowsKeychain("buildex-beta", run).set("connector:gmail", "b");
    expect(store.size).toBe(2);
  });

  it("throws when a write fails (non-zero, non-not-found exit)", () => {
    // Reads succeed (absent) so the pre-read succeeds; only the write fails - so we exercise the write path.
    const failing: WinCredRunner = (op) =>
      op.action === "write" ? { status: 5, stdout: "" } : { status: WIN_NOT_FOUND, stdout: "" };
    expect(() => new WindowsKeychain("buildex-test", failing).set("k", "v")).toThrow(/keychain write failed/);
  });

  it("set() refuses on a real backend error, even when the failure is in its pre-read", () => {
    // get()'s former "throws on a read failure" contract was SUPERSEDED by macOS parity - see the
    // parity suite below. The write path deliberately stays strict, so a set can never silently no-op.
    const failing: WinCredRunner = () => ({ status: 5, stdout: "" });
    expect(() => new WindowsKeychain("buildex-test", failing).set("k", "v")).toThrow(/keychain/);
  });

  describe("chunking (values larger than one 2560-byte credential blob)", () => {
    const big = "x".repeat(8000); // base64 ~10.7k -> several chunks

    it("chunks a large value and reassembles it exactly", () => {
      const { run, store } = fakeCredManager();
      const kc = new WindowsKeychain("buildex-test", run);
      kc.set("tokens", big);
      expect(store.get("buildex-test:tokens")!.startsWith("|BXK1|")).toBe(true); // header, not raw
      expect(chunkKeys(store, "buildex-test:tokens").length).toBeGreaterThan(1);
      expect(kc.get("tokens")).toBe(big);
    });

    it("keeps chunked payloads base64 (never plaintext)", () => {
      const { run, store } = fakeCredManager();
      new WindowsKeychain("buildex-test", run).set("k", "SECRET".repeat(2000));
      for (const v of store.values()) expect(v).not.toContain("SECRETSECRET");
    });

    it("replacing a chunked value with a small one prunes the stale chunks", () => {
      const { run, store } = fakeCredManager();
      const kc = new WindowsKeychain("buildex-test", run);
      kc.set("k", big);
      expect(chunkKeys(store, "buildex-test:k").length).toBeGreaterThan(1);
      kc.set("k", "small");
      expect(kc.get("k")).toBe("small");
      expect(chunkKeys(store, "buildex-test:k").length).toBe(0);
    });

    it("a shorter chunked value drops surplus chunk siblings", () => {
      const { run, store } = fakeCredManager();
      const kc = new WindowsKeychain("buildex-test", run);
      kc.set("k", "z".repeat(20000));
      const before = chunkKeys(store, "buildex-test:k").length;
      kc.set("k", "z".repeat(8000));
      const after = chunkKeys(store, "buildex-test:k").length;
      expect(after).toBeLessThan(before);
      expect(kc.get("k")).toBe("z".repeat(8000));
    });

    it("deleting a chunked value removes the header and every chunk", () => {
      const { run, store } = fakeCredManager();
      const kc = new WindowsKeychain("buildex-test", run);
      kc.set("k", big);
      kc.delete("k");
      expect(kc.get("k")).toBeUndefined();
      expect([...store.keys()].filter((t) => t.startsWith("buildex-test:k"))).toEqual([]);
    });

    it("a missing chunk (torn write) reads back as undefined, never truncated", () => {
      const { run, store } = fakeCredManager();
      const kc = new WindowsKeychain("buildex-test", run);
      kc.set("k", big);
      store.delete("buildex-test:k#1");
      expect(kc.get("k")).toBeUndefined();
    });

    it("a corrupted chunk (checksum mismatch) reads back as undefined", () => {
      const { run, store } = fakeCredManager();
      const kc = new WindowsKeychain("buildex-test", run);
      kc.set("k", big);
      store.set("buildex-test:k#0", "QUJD"); // clobber a chunk with valid base64 of different content
      expect(kc.get("k")).toBeUndefined();
    });
  });
});

describe("createKeychain factory - win32", () => {
  it("mode 'auto' on win32 with an injected runner -> WindowsKeychain", () => {
    const { run } = fakeCredManager();
    expect(createKeychain({ mode: "auto", workspace: "/ws", winRun: run, platform: "win32" })).toBeInstanceOf(
      WindowsKeychain,
    );
  });

  it("mode 'system' on win32 with an injected runner -> WindowsKeychain (does not throw)", () => {
    const { run } = fakeCredManager();
    expect(createKeychain({ mode: "system", workspace: "/ws", winRun: run, platform: "win32" })).toBeInstanceOf(
      WindowsKeychain,
    );
  });

  it("namespaces the service per workspace on win32 (different workspaces don't collide)", () => {
    const { run, store } = fakeCredManager();
    createKeychain({ mode: "system", workspace: "/ws/alpha", winRun: run, platform: "win32" }).set("connector:gmail", "a");
    createKeychain({ mode: "system", workspace: "/ws/beta", winRun: run, platform: "win32" }).set("connector:gmail", "b");
    expect(store.size).toBe(2); // two distinct service prefixes
  });
});

describe("WindowsKeychain - macOS contract parity when the backend itself fails", () => {
  // A machine where the helper cannot run at all: PowerShell Constrained Language Mode blocks
  // Add-Type on managed/enterprise Windows, so every op exits non-zero and non-WIN_NOT_FOUND.
  const broken: WinCredRunner = () => ({ status: 5, stdout: "" });

  it("get() degrades to undefined instead of throwing (SystemKeychain.get swallows all non-zero)", () => {
    // Otherwise every connector route hard-fails on such a machine, where macOS would simply show
    // "not connected" - and mode:"auto" picks this backend happily, since availability is existence-only.
    expect(new WindowsKeychain("svc", broken).get("k")).toBeUndefined();
  });

  it("set() still throws, so an explicit persistence failure stays loud (macOS set throws too)", () => {
    expect(() => new WindowsKeychain("svc", broken).set("k", "v")).toThrow();
  });

  it("delete() tolerates a failing pre-read, like the macOS peer's fire-and-forget delete", () => {
    expect(() => new WindowsKeychain("svc", broken).delete("k")).not.toThrow();
  });
});

// A fake vault that also RECORDS the operation sequence and can be armed to die partway through, so
// the crash windows between individual credential operations are testable. There is no transaction
// across Credential Manager writes: the process can be killed (or the machine cut) between any two,
// so the ORDER of operations is the only thing standing between a revoked secret and a permanent leak.
function crashableCredManager() {
  const store = new Map<string, string>();
  const ops: string[] = [];
  let budget = Number.POSITIVE_INFINITY;
  const run: WinCredRunner = (op) => {
    if (ops.length >= budget) throw new Error("simulated crash: the process died mid-operation");
    ops.push(`${op.action} ${op.target}`);
    switch (op.action) {
      case "write":
        store.set(op.target, op.value);
        return { status: 0, stdout: "" };
      case "read": {
        const v = store.get(op.target);
        return v === undefined ? { status: WIN_NOT_FOUND, stdout: "" } : { status: 0, stdout: v };
      }
      case "delete":
        store.delete(op.target);
        return { status: 0, stdout: "" };
    }
  };
  return {
    run,
    store,
    ops,
    /** Die after `n` further operations. */
    arm: (n: number) => { budget = ops.length + n; },
    disarm: () => { budget = Number.POSITIVE_INFINITY; },
  };
}

/** Big enough to need several chunks: 5000 bytes -> 6668 base64 chars -> 4 chunks at CHUNK_LIMIT. */
const BIG_SECRET = "s".repeat(5000);

describe("WindowsKeychain - no crash window may strand secret material", () => {
  it("delete: a crash at ANY point still converges to an empty vault on retry", () => {
    // The leak: delete() removes the header first, then prunes chunks. Killed in between, chunks
    // #0..#n-1 - which together ARE the complete base64 secret - survive. The retry reads no header,
    // computes oldN = 0, and never prunes them. A revoked OAuth token then outlives its revocation,
    // readable by any process running as the same user (`cmdkey /list` + a trivial CredRead).
    for (let crashAfter = 0; crashAfter <= 12; crashAfter++) {
      const v = crashableCredManager();
      new WindowsKeychain("svc", v.run).set("k", BIG_SECRET); // seed, uninterrupted
      expect(v.store.size).toBeGreaterThan(1); // sanity: really chunked

      v.arm(crashAfter);
      try {
        new WindowsKeychain("svc", v.run).delete("k");
      } catch {
        /* the power cut */
      }
      v.disarm();

      new WindowsKeychain("svc", v.run).delete("k"); // the operator retries
      expect([...v.store.keys()], `stranded after crashAfter=${crashAfter}`).toEqual([]);
    }
  });

  it("set: a crash while shrinking a value cannot strand the previous, larger secret", () => {
    // Same ordering flaw on the write path: the new value is committed before the now-surplus chunks
    // of the OLD value are pruned. The survivors are fragments of the secret being replaced.
    for (let crashAfter = 0; crashAfter <= 12; crashAfter++) {
      const v = crashableCredManager();
      new WindowsKeychain("svc", v.run).set("k", BIG_SECRET);

      v.arm(crashAfter);
      try {
        new WindowsKeychain("svc", v.run).set("k", "small");
      } catch {
        /* the power cut */
      }
      v.disarm();

      new WindowsKeychain("svc", v.run).delete("k");
      expect([...v.store.keys()], `stranded after crashAfter=${crashAfter}`).toEqual([]);
    }
  });

  it("set: a crash while GROWING a value cannot strand the chunks the old header never recorded", () => {
    // The ordering fix alone does not close this one. Growing 4 chunks -> 7 writes #4,#5,#6, which the
    // still-current header (n=4) does not describe. Killed before the header commit, a later delete
    // trusts that header, prunes #0..#3, and strands #4..#6 - the tail of the new secret, forever.
    const BIGGER = "s".repeat(9000); // 12000 base64 chars -> 6 chunks, vs BIG_SECRET's 4
    for (let crashAfter = 0; crashAfter <= 16; crashAfter++) {
      const v = crashableCredManager();
      new WindowsKeychain("svc", v.run).set("k", BIG_SECRET);

      v.arm(crashAfter);
      try {
        new WindowsKeychain("svc", v.run).set("k", BIGGER);
      } catch {
        /* the power cut */
      }
      v.disarm();

      new WindowsKeychain("svc", v.run).delete("k");
      expect([...v.store.keys()], `stranded after crashAfter=${crashAfter}`).toEqual([]);
    }
  });

  it("pins the ordering invariant: every chunk delete precedes the header write/delete", () => {
    // The structural guarantee behind both tests above, asserted directly on the op sequence so it
    // cannot silently regress: the header is the commit point, so nothing may be pruned after it.
    const v = crashableCredManager();
    const kc = new WindowsKeychain("svc", v.run);
    kc.set("k", BIG_SECRET);
    v.ops.length = 0;

    kc.delete("k");
    const headerOp = v.ops.indexOf("delete svc:k");
    const chunkOps = v.ops.map((o, i) => [o, i] as const).filter(([o]) => o.startsWith("delete svc:k#"));
    expect(headerOp).toBeGreaterThanOrEqual(0);
    expect(chunkOps.length).toBeGreaterThan(0);
    for (const [op, i] of chunkOps) expect(i, `${op} must precede the header delete`).toBeLessThan(headerOp);
  });
});
