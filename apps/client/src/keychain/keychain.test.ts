import { describe, it, expect } from "vitest";
import { InMemoryKeychain, SystemKeychain, createKeychain, type SecurityRunner } from "./keychain.js";

// A stateful fake of the macOS `security` CLI: an in-memory (service+account → stored password) map
// that mirrors the real exit codes we probed (44 = not found, 0 = ok) and the trailing-newline print.
function fakeSecurity() {
  const store = new Map<string, string>();
  const argOf = (args: string[], flag: string) => args[args.indexOf(flag) + 1]!;
  const keyOf = (args: string[]) => `${argOf(args, "-s")} / ${argOf(args, "-a")}`;
  const run: SecurityRunner = (args) => {
    switch (args[0]) {
      case "add-generic-password":
        store.set(keyOf(args), argOf(args, "-w")); // -U → update-or-add
        return { status: 0, stdout: "" };
      case "find-generic-password": {
        const v = store.get(keyOf(args));
        return v === undefined ? { status: 44, stdout: "" } : { status: 0, stdout: v + "\n" };
      }
      case "delete-generic-password":
        return { status: store.delete(keyOf(args)) ? 0 : 44, stdout: "" };
      default:
        return { status: 1, stdout: "" };
    }
  };
  return { run, store };
}

describe("SystemKeychain - macOS security-backed persistence", () => {
  it("round-trips a value (set → get) via the injected runner", () => {
    const { run } = fakeSecurity();
    const kc = new SystemKeychain("buildex-test", run);
    kc.set("connector:gmail:oauth:tokens", JSON.stringify({ accessToken: "AT", refreshToken: "RT" }));
    expect(JSON.parse(kc.get("connector:gmail:oauth:tokens")!)).toMatchObject({ accessToken: "AT" });
  });

  it("returns undefined for a missing key (security exit 44)", () => {
    const { run } = fakeSecurity();
    expect(new SystemKeychain("buildex-test", run).get("nope")).toBeUndefined();
  });

  it("stores the value base64-encoded, never as plaintext (argv/store hygiene)", () => {
    const { run, store } = fakeSecurity();
    new SystemKeychain("buildex-test", run).set("k", "super-secret-token");
    const stored = [...store.values()][0]!;
    expect(stored).not.toContain("super-secret-token");
    expect(Buffer.from(stored, "base64").toString("utf8")).toBe("super-secret-token");
  });

  it("update-or-add: setting the same key twice keeps the latest", () => {
    const { run } = fakeSecurity();
    const kc = new SystemKeychain("buildex-test", run);
    kc.set("k", "first");
    kc.set("k", "second");
    expect(kc.get("k")).toBe("second");
  });

  it("delete removes it; deleting a missing key does not throw", () => {
    const { run } = fakeSecurity();
    const kc = new SystemKeychain("buildex-test", run);
    kc.set("k", "v");
    kc.delete("k");
    expect(kc.get("k")).toBeUndefined();
    expect(() => kc.delete("k")).not.toThrow();
  });

  it("namespaces the keychain service per workspace (same key, different workspaces don't collide)", () => {
    const { run, store } = fakeSecurity();
    createKeychain({ mode: "system", workspace: "/ws/alpha", run, platform: "darwin" }).set("connector:gmail", "a");
    createKeychain({ mode: "system", workspace: "/ws/beta", run, platform: "darwin" }).set("connector:gmail", "b");
    expect(store.size).toBe(2); // two distinct service entries
  });
});

describe("createKeychain factory", () => {
  it("mode 'memory' → InMemoryKeychain", () => {
    expect(createKeychain({ mode: "memory", workspace: "/ws" })).toBeInstanceOf(InMemoryKeychain);
  });
  it("mode 'auto' on darwin with security available → persistent (SystemKeychain)", () => {
    const { run } = fakeSecurity();
    const kc = createKeychain({ mode: "auto", workspace: "/ws", run, platform: "darwin" });
    expect(kc).toBeInstanceOf(SystemKeychain);
  });
  it("mode 'auto' off darwin → falls back to in-memory (never a plaintext file)", () => {
    const { run } = fakeSecurity();
    expect(createKeychain({ mode: "auto", workspace: "/ws", run, platform: "linux" })).toBeInstanceOf(InMemoryKeychain);
  });
  it("mode 'system' where the OS keychain is unavailable → throws (explicit opt-in must not silently degrade)", () => {
    expect(() => createKeychain({ mode: "system", workspace: "/ws", platform: "linux" })).toThrow(/keychain/i);
  });
});
