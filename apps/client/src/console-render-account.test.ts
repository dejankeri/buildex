// Browser test net for the account seam's console UI (Task 10): the first-run wizard's final step
// gains a real "connect an account" affordance (base URL + setup code + Connect), replacing the old
// "coming soon" placeholder; and the sync dot's local-workspace tooltip drops its stale "coming"
// framing now that the feature exists. Loads the REAL bundle into jsdom (see console-harness.ts) and
// routes fetch to controlled JSON, per the pattern in console-render-connectors.test.ts.
import { describe, it, expect } from "vitest";
import { loadConsole } from "./console-harness.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function routeFetch(w: any, routes: Array<[string, unknown]>): void {
  w.fetch = (url: string) => {
    for (const [pat, data] of routes) {
      if (String(url).includes(pat)) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
    }
    return Promise.reject(new Error("no route: " + url));
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function advanceToLastStep(doc: any, n = 3): void {
  for (let k = 0; k < n; k++) doc.querySelector(".wz-primary").click();
}

describe("console renderers (jsdom) — onboarding's final step connects an account", () => {
  it("shows a base-URL + setup-code field when the org is local, not the 'coming' placeholder", async () => {
    const { doc, w, c } = loadConsole();
    routeFetch(w, [
      ["/api/onboarding", { firstRun: true, agent: { available: true, version: "1.0.0" } }],
      ["/api/account", { state: "local" }],
    ]);
    await c.checkOnboarding();
    advanceToLastStep(doc);
    const body = doc.querySelector(".wz-body")!;
    expect(body.textContent).not.toMatch(/coming/i);
    expect(body.querySelectorAll("input")).toHaveLength(2);
    expect(doc.querySelector("#wz-connect")).not.toBeNull();
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  it("POSTs {baseUrl, setupToken} on Connect and, once connected, hides the form", async () => {
    const { doc, w, c } = loadConsole();
    let posted: unknown = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (w as any).fetch = (url: string, opts: any) => {
      const u = String(url);
      if (u.includes("/api/onboarding")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ firstRun: true, agent: { available: true } }) });
      if (u.includes("/api/account") && opts && opts.method === "POST") {
        posted = JSON.parse(opts.body);
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ state: "connected", companySlug: "acme" }) });
      }
      if (u.includes("/api/account")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ state: "local" }) });
      // refreshProjects() fires after a successful connect - stub it out benignly.
      if (u.includes("/api/projects")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ projects: [{ id: "p1", name: "Workspace", items: [] }] }) });
      if (u.includes("/api/sessions")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ sessions: [] }) });
      if (u.includes("/api/sync")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ status: "ok", unsaved: { files: 0, oldestAt: null, stale: false, connected: true } }) });
      return Promise.reject(new Error("no route: " + u));
    };
    await c.checkOnboarding();
    advanceToLastStep(doc);
    (doc.querySelector("#wz-baseurl") as unknown as { value: string }).value = "https://sync.acme.dev";
    (doc.querySelector("#wz-code") as unknown as { value: string }).value = "setup_abc123";
    (doc.querySelector("#wz-connect") as unknown as { click(): void }).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(posted).toEqual({ baseUrl: "https://sync.acme.dev", setupToken: "setup_abc123" });
    expect(doc.querySelector("#wz-connect")).toBeNull(); // the form is gone
    expect(doc.querySelector("#wz-baseurl")).toBeNull();
    expect(doc.querySelector(".wz-body")!.textContent).toContain("acme");
  });

  it("shows the returned error inline on a 4xx, and leaves the form in place to retry", async () => {
    const { doc, w, c } = loadConsole();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (w as any).fetch = (url: string, opts: any) => {
      const u = String(url);
      if (u.includes("/api/onboarding")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ firstRun: true, agent: { available: true } }) });
      if (u.includes("/api/account") && opts && opts.method === "POST") {
        return Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ error: "invalid setup code" }) });
      }
      if (u.includes("/api/account")) return Promise.reject(new Error("network")); // GET fails - treated as not-connected
      return Promise.reject(new Error("no route: " + u));
    };
    await c.checkOnboarding();
    advanceToLastStep(doc);
    (doc.querySelector("#wz-connect") as unknown as { click(): void }).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(doc.querySelector(".wz-body")!.textContent).toContain("invalid setup code");
    expect(doc.querySelector("#wz-connect")).not.toBeNull(); // still there - the operator can retry
  });

  it("operator copy never uses push/commit/branch/merge/diff, and 'token' stays out of labels", async () => {
    const { doc, w, c } = loadConsole();
    routeFetch(w, [
      ["/api/onboarding", { firstRun: true, agent: { available: true } }],
      ["/api/account", { state: "local" }],
    ]);
    await c.checkOnboarding();
    advanceToLastStep(doc);
    const text = doc.querySelector(".wz-body")!.textContent!;
    expect(text).not.toMatch(/\b(push|commit|branch|merge|diff)\b/i);
    // "setup code" is the label; the input's placeholder may say "code" but the field itself is
    // never labeled with the word "token".
    const codeInput = doc.querySelector("#wz-code")!;
    expect((codeInput.getAttribute("placeholder") || "") + text.toLowerCase()).not.toContain("token");
  });
});

describe("console renderers (jsdom) — sync dot's local-workspace copy", () => {
  it("tells the operator work stays on this machine while local, without promising accounts are 'coming'", () => {
    const { doc, c } = loadConsole();
    c.setSync("local");
    const title = doc.querySelector("#sync")!.getAttribute("title")!;
    expect(title.toLowerCase()).not.toContain("coming");
    expect(title).toMatch(/this machine/i);
  });

  it("once connected, the sync surface drops the local-only 'stays on this machine' copy", async () => {
    const { doc, w, c } = loadConsole();
    routeFetch(w, [
      ["/api/projects", { projects: [{ id: "p1", name: "Workspace", items: [] }] }],
      ["/api/sessions", { sessions: [] }],
      ["/api/sync", { status: "ok", unsaved: { files: 0, oldestAt: null, stale: false, connected: true } }],
    ]);
    await c.refreshProjects();
    const title = doc.querySelector("#sync")!.getAttribute("title")!;
    expect(title).not.toMatch(/stays on this machine/i);
  });
});
