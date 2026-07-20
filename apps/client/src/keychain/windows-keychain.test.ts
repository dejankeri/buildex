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

  it("throws when a read fails (a real backend error, not a missing key)", () => {
    const failing: WinCredRunner = () => ({ status: 5, stdout: "" });
    expect(() => new WindowsKeychain("buildex-test", failing).get("k")).toThrow(/keychain read failed/);
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
