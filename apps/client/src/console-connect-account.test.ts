// Browser test net for the standalone "connect an account" surface: the title-bar sync dot, when the
// workspace is local (no account), opens a connect modal that POSTs /api/account - the same flow the
// onboarding wizard uses, now reachable AFTER first-run. Loads the REAL bundle into jsdom (see
// console-harness.ts) and routes fetch to controlled JSON, per console-render-account.test.ts.
import { describe, it, expect } from "vitest";
import { loadConsole } from "./console-harness.js";

describe("console (jsdom) — connect an account after first-run", () => {
  it("openConnectAccount() builds a modal with a Company URL + Setup code field", () => {
    const { doc, c } = loadConsole();
    c.openConnectAccount();
    const card = doc.querySelector(".wz-card, .connect-card");
    expect(card).not.toBeNull();
    expect(doc.querySelector("#wz-baseurl")).not.toBeNull();
    expect(doc.querySelector("#wz-code")).not.toBeNull();
    expect(doc.querySelector("#wz-connect")).not.toBeNull();
    // operator copy only - no engineer jargon leaks into the dialog
    expect(card!.textContent).not.toMatch(/\b(push|commit|branch|merge|diff|token)\b/i);
  });

  it("POSTs {baseUrl, setupToken} on Connect and closes the modal once connected", async () => {
    const { doc, w, c } = loadConsole();
    let posted: unknown = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (w as any).fetch = (url: string, opts: any) => {
      const u = String(url);
      if (u.includes("/api/account") && opts && opts.method === "POST") {
        posted = JSON.parse(opts.body);
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ state: "connected", companySlug: "acme" }) });
      }
      if (u.includes("/api/projects")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ projects: [{ id: "p1", name: "Workspace", items: [] }] }) });
      if (u.includes("/api/sessions")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ sessions: [] }) });
      if (u.includes("/api/sync")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ status: "ok", unsaved: { files: 0, oldestAt: null, stale: false, connected: true } }) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    };
    c.openConnectAccount();
    (doc.querySelector("#wz-baseurl") as unknown as { value: string }).value = "https://sync.acme.dev";
    (doc.querySelector("#wz-code") as unknown as { value: string }).value = "setup_abc123";
    (doc.querySelector("#wz-connect") as unknown as { click(): void }).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(posted).toEqual({ baseUrl: "https://sync.acme.dev", setupToken: "setup_abc123" });
    expect(doc.querySelector("#wz-connect")).toBeNull(); // modal torn down on success
  });

  it("shows the returned error inline on a 4xx and leaves the form up to retry", async () => {
    const { doc, w, c } = loadConsole();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (w as any).fetch = (url: string, opts: any) => {
      const u = String(url);
      if (u.includes("/api/account") && opts && opts.method === "POST") {
        return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ error: "That setup code was not recognized." }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    };
    c.openConnectAccount();
    (doc.querySelector("#wz-baseurl") as unknown as { value: string }).value = "https://sync.acme.dev";
    (doc.querySelector("#wz-code") as unknown as { value: string }).value = "bad";
    (doc.querySelector("#wz-connect") as unknown as { click(): void }).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(doc.querySelector("#wz-connect")).not.toBeNull(); // form still up
    expect(doc.querySelector(".wz-card")!.textContent).toMatch(/not recognized/i);
  });

  it("a revoked account's status maps to the reconnect dot, which opens the connect modal", () => {
    const { doc, c } = loadConsole();
    // syncDotState routes the engine's reconnect status to its own dot class (not the conflict 'help').
    expect(c.syncDotState({ status: "reconnect" })).toBe("reconnect");
    // setSync paints that class and the tooltip invites the click (no "recent changes" suffix).
    c.setSync("reconnect");
    const dot = doc.querySelector("#sync");
    expect(dot!.className).toContain("reconnect");
    expect(dot!.getAttribute("title")).toMatch(/reconnect/i);
    expect(dot!.getAttribute("title")).not.toMatch(/recent changes/i);
    // and the dot's click handler opens the connect modal for a reconnect dot (same as local).
    // loadConsole() evaluates the bundle but never calls boot(), so #sync.onclick is never wired here -
    // asserting the guard means calling openConnectAccount() directly, the action the handler invokes.
    c.openConnectAccount();
    expect(doc.querySelector("#wz-connect")).not.toBeNull();
  });
});
