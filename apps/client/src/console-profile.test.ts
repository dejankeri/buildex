// Browser test net for the console profile menu (Task 3): the title-bar account home. Loads the
// REAL bundle into jsdom (see console-harness.ts) and routes fetch to controlled JSON, mirroring
// console-signin.test.ts's routeFetch idiom.
import { describe, it, expect } from "vitest";
import { loadConsole } from "./console-harness.js";

// Operator-facing copy must never leak engineer jargon - same bar as console-signin.test.ts.
const BANNED = /\b(push|commit|branch|merge|diff|token|jwt)\b/i;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function routeFetch(w: any, routes: Array<[string, unknown]>): void {
  w.fetch = (url: string) => {
    for (const [pat, data] of routes) {
      if (String(url).includes(pat)) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
    }
    return Promise.reject(new Error("no route: " + url));
  };
}

describe("console (jsdom) — openProfile() menu", () => {
  it("signed out (local, signInAvailable): a Sign in action + Have a setup code?, no company line, no Log out", async () => {
    const { doc, w, c } = loadConsole();
    routeFetch(w, [
      ["/api/account", { state: "local" }],
      ["/api/sync", { signInAvailable: true }],
    ]);
    await c.openProfile();
    const menu = doc.querySelector(".profile-menu");
    expect(menu).not.toBeNull();
    expect(menu!.textContent).toContain("Sign in");
    expect(menu!.textContent).toContain("Have a setup code?");
    expect(menu!.textContent).not.toContain("Log out");
    expect(menu!.textContent).not.toMatch(/connected to/i);
    expect(menu!.textContent).not.toMatch(BANNED);
  });

  it("connected: shows the company and Log out, NOT the sign-in actions", async () => {
    const { doc, w, c } = loadConsole();
    routeFetch(w, [
      ["/api/account", { state: "connected", companySlug: "acme" }],
      ["/api/sync", { signInAvailable: true }],
    ]);
    await c.openProfile();
    const menu = doc.querySelector(".profile-menu");
    expect(menu).not.toBeNull();
    expect(menu!.textContent).toContain("acme");
    expect(menu!.textContent).toContain("Log out");
    expect(menu!.textContent).not.toContain("Sign in");
    expect(menu!.textContent).not.toContain("Have a setup code?");
    expect(menu!.textContent).not.toMatch(BANNED);
  });

  it("does not stack a second menu on a repeat call", async () => {
    const { doc, w, c } = loadConsole();
    routeFetch(w, [
      ["/api/account", { state: "local" }],
      ["/api/sync", { signInAvailable: true }],
    ]);
    await Promise.all([c.openProfile(), c.openProfile()]);
    expect(doc.querySelectorAll(".profile-menu")).toHaveLength(1);
  });

  it("clicking Log out shows a confirm mentioning the device stays local; confirming POSTs /api/logout and on {state:'local'} tears down + refreshes", async () => {
    const { doc, w, c } = loadConsole();
    let posted: unknown = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (w as any).fetch = (url: string, opts: any) => {
      const u = String(url);
      if (u.includes("/api/account")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ state: "connected", companySlug: "acme" }) });
      if (u.includes("/api/sync") && !opts) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ signInAvailable: true }) });
      if (u.includes("/api/logout") && opts && opts.method === "POST") {
        posted = opts.body ? JSON.parse(opts.body) : {};
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ state: "local" }) });
      }
      if (u.includes("/api/projects")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ projects: [{ id: "p1", name: "Workspace", items: [] }] }) });
      if (u.includes("/api/sessions")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ sessions: [] }) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    };
    await c.openProfile();
    const logoutBtn = Array.from(doc.querySelectorAll(".profile-menu button") as unknown as JsdomButtonList).find(
      (b) => b.textContent === "Log out",
    );
    expect(logoutBtn).toBeTruthy();
    logoutBtn!.click();
    const confirmCard = doc.querySelector(".logout-modal");
    expect(confirmCard).not.toBeNull();
    expect(confirmCard!.textContent).toMatch(/your work stays on this machine/i);
    expect(confirmCard!.textContent).not.toMatch(BANNED);
    (doc.querySelector("#wz-logout-confirm") as unknown as { click(): void }).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(posted).toEqual({});
    expect(doc.querySelector(".logout-modal")).toBeNull(); // confirm torn down
    expect(doc.querySelector("#convos .project")).not.toBeNull(); // refreshProjects() repainted the rail
  });

  it("Cancel on the logout confirm closes it without posting anything", async () => {
    const { doc, w, c } = loadConsole();
    let posted = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (w as any).fetch = (url: string, opts: any) => {
      const u = String(url);
      if (opts && opts.method === "POST") posted = true;
      if (u.includes("/api/account")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ state: "connected", companySlug: "acme" }) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    };
    await c.openProfile();
    const logoutBtn = Array.from(doc.querySelectorAll(".profile-menu button") as unknown as JsdomButtonList).find(
      (b) => b.textContent === "Log out",
    );
    logoutBtn!.click();
    (doc.querySelector('.logout-modal [data-a="cancel"]') as unknown as { click(): void }).click();
    expect(doc.querySelector(".logout-modal")).toBeNull();
    expect(posted).toBe(false);
  });
});

// A minimal typed view over the jsdom NodeList this file iterates with Array.from/find.
type JsdomButtonList = ArrayLike<{ textContent: string | null; click(): void }>;
