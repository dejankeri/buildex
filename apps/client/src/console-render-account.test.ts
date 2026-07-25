// Browser test net for the account seam's console UI: the first-run wizard's final step offers a
// real choice - back up with Google, or stay local - and never asks for a company URL or a setup
// code, neither of which a self-serve operator has. The sync dot's local-workspace tooltip states
// that work stays on this machine. Loads the REAL bundle into jsdom (see console-harness.ts) and
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

describe("console renderers (jsdom) — onboarding's final step offers backup, never a setup code", () => {
  it("offers Google backup when sign-in is wired, and asks for no URL or code", async () => {
    const { doc, w, c } = loadConsole();
    routeFetch(w, [
      ["/api/onboarding", { firstRun: true, agent: { available: true, version: "1.0.0" } }],
      ["/api/account", { state: "local" }],
      ["/api/sync", { status: "ok", signInAvailable: true, unsaved: { files: 0, oldestAt: null, stale: false, connected: false } }],
    ]);
    await c.checkOnboarding();
    advanceToLastStep(doc);
    const body = doc.querySelector(".wz-body")!;
    expect(doc.querySelector("#wz-signin-google")).not.toBeNull();
    // The regression this guards: an operator was shown "Company URL" and "Setup code" - two things
    // a self-serve user has never heard of and cannot supply. There are no free-text fields here.
    expect(body.querySelectorAll("input")).toHaveLength(0);
    expect(body.textContent).not.toMatch(/setup code|company url/i);
  });

  it("says work stays on this machine, and offers nothing, when sign-in is dormant", async () => {
    const { doc, w, c } = loadConsole();
    routeFetch(w, [
      ["/api/onboarding", { firstRun: true, agent: { available: true } }],
      ["/api/account", { state: "local" }],
      ["/api/sync", { status: "ok", signInAvailable: false, unsaved: { files: 0, oldestAt: null, stale: false, connected: false } }],
    ]);
    await c.checkOnboarding();
    advanceToLastStep(doc);
    // A dormant build is local-forever. A backup button here would dead-end at a 501, so there is none.
    expect(doc.querySelector("#wz-signin-google")).toBeNull();
    expect(doc.querySelector(".wz-body")!.textContent).toMatch(/stays on this machine/i);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  it("POSTs /api/signin on backup and, once connected, names the company from /api/account", async () => {
    const { doc, w, c } = loadConsole();
    let posted: unknown = null;
    let connected = false;
    // FAITHFUL to the daemon: POST /api/signin returns {state} and NOTHING else (daemon.ts just
    // `json(await deps.signIn())`). The company slug lives on GET /api/account. An earlier version
    // of this test had the signin fake return a companySlug the real endpoint never sends, so it
    // passed while the live app rendered an unnamed "Your work is backed up." after a real sign-in.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (w as any).fetch = (url: string, opts: any) => {
      const u = String(url);
      const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
      if (u.includes("/api/onboarding")) return ok({ firstRun: true, agent: { available: true } });
      if (u.includes("/api/signin") && opts && opts.method === "POST") {
        posted = JSON.parse(opts.body);
        connected = true;
        return ok({ state: "connected" });
      }
      if (u.includes("/api/account")) return ok(connected ? { state: "connected", companySlug: "acme" } : { state: "local" });
      if (u.includes("/api/projects")) return ok({ projects: [{ id: "p1", name: "Workspace", items: [] }] });
      if (u.includes("/api/sessions")) return ok({ sessions: [] });
      if (u.includes("/api/sync")) return ok({ status: "ok", signInAvailable: true, unsaved: { files: 0, oldestAt: null, stale: false, connected } });
      return Promise.reject(new Error("no route: " + u));
    };
    await c.checkOnboarding();
    advanceToLastStep(doc);
    (doc.querySelector("#wz-signin-google") as unknown as { click(): void }).click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0)); // the re-read of /api/account is a second microtask hop
    expect(posted).toEqual({ provider: "google" });
    expect(doc.querySelector("#wz-signin-google")).toBeNull(); // the button is gone
    expect(doc.querySelector(".wz-body")!.textContent).toContain("acme");
  });

  it("shows the returned error inline on a failure, and leaves the button to retry", async () => {
    const { doc, w, c } = loadConsole();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (w as any).fetch = (url: string, opts: any) => {
      const u = String(url);
      if (u.includes("/api/onboarding")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ firstRun: true, agent: { available: true } }) });
      if (u.includes("/api/signin") && opts && opts.method === "POST") {
        return Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ error: "sign-in was denied" }) });
      }
      if (u.includes("/api/sync")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ status: "ok", signInAvailable: true, unsaved: { files: 0, oldestAt: null, stale: false, connected: false } }) });
      if (u.includes("/api/account")) return Promise.reject(new Error("network")); // GET fails - treated as not-connected
      return Promise.reject(new Error("no route: " + u));
    };
    await c.checkOnboarding();
    advanceToLastStep(doc);
    (doc.querySelector("#wz-signin-google") as unknown as { click(): void }).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(doc.querySelector(".wz-body")!.textContent).toContain("sign-in was denied");
    expect(doc.querySelector("#wz-signin-google")).not.toBeNull(); // still there - the operator can retry
  });

  it("operator copy never uses push/commit/branch/merge/diff, and never says token", async () => {
    const { doc, w, c } = loadConsole();
    routeFetch(w, [
      ["/api/onboarding", { firstRun: true, agent: { available: true } }],
      ["/api/account", { state: "local" }],
      ["/api/sync", { status: "ok", signInAvailable: true, unsaved: { files: 0, oldestAt: null, stale: false, connected: false } }],
    ]);
    await c.checkOnboarding();
    advanceToLastStep(doc);
    const text = doc.querySelector(".wz-body")!.textContent!;
    expect(text).not.toMatch(/\b(push|commit|branch|merge|diff)\b/i);
    expect(text.toLowerCase()).not.toContain("token");
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
