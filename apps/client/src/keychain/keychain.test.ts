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
      case "delete-generic-password": {
        // `-s <service>` alone (no `-a`): remove ONE item under that service - the real CLI's
        // by-service delete, which `clear()` loops until 44. With `-a` present, an exact-key delete.
        if (!args.includes("-a")) {
          const service = argOf(args, "-s");
          const hit = [...store.keys()].find((k) => k.startsWith(`${service} / `));
          if (hit === undefined) return { status: 44, stdout: "" };
          store.delete(hit);
          return { status: 0, stdout: "" };
        }
        return { status: store.delete(keyOf(args)) ? 0 : 44, stdout: "" };
      }
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

  it("clear() wipes every key under this workspace's service - whoever wrote it", () => {
    const { run, store } = fakeSecurity();
    const kc = new SystemKeychain("buildex-shared", run);
    kc.set("git:token", "T");
    kc.set("connector:gmail:oauth:tokens", "G");
    kc.set("connector:slack:oauth:tokens", "S");
    kc.clear();
    expect(kc.get("git:token")).toBeUndefined();
    expect(kc.get("connector:gmail:oauth:tokens")).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("clear() touches only THIS service - another workspace's secrets survive (invariant 6)", () => {
    const { run } = fakeSecurity();
    const a = createKeychain({ mode: "system", workspace: "/ws/alpha", run, platform: "darwin" });
    const b = createKeychain({ mode: "system", workspace: "/ws/beta", run, platform: "darwin" });
    a.set("connector:gmail", "a");
    b.set("connector:gmail", "b");
    a.clear();
    expect(a.get("connector:gmail")).toBeUndefined();
    expect(b.get("connector:gmail")).toBe("b"); // the other tenant is untouched
  });

  it("path-reuse bleed is closed: a NEW keychain at a reused path reads nothing after the old one is cleared", () => {
    const { run } = fakeSecurity();
    const oldCompany = createKeychain({ mode: "system", workspace: "/orgs/demo/workspace", run, platform: "darwin" });
    oldCompany.set("connector:gmail:oauth:tokens", "OLD-COMPANY-SECRET");
    oldCompany.clear(); // the provisioning purge, run before the path is reused
    const newCompany = createKeychain({ mode: "system", workspace: "/orgs/demo/workspace", run, platform: "darwin" });
    expect(newCompany.get("connector:gmail:oauth:tokens")).toBeUndefined();
  });
});

describe("InMemoryKeychain", () => {
  it("clear() empties the store", () => {
    const kc = new InMemoryKeychain();
    kc.set("a", "1");
    kc.set("b", "2");
    kc.clear();
    expect(kc.get("a")).toBeUndefined();
    expect(kc.get("b")).toBeUndefined();
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
