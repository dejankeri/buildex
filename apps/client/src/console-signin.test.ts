// Browser test net for the sign-in surface (Task 11): the left-rail "back up & sync" pill, the
// pending tray's contextual card, and the sign-in modal itself. All three exist ONLY while the
// workspace has no connected account (`unsaved.connected === false`) and disappear the moment one
// is. Loads the REAL bundle into jsdom (see console-harness.ts) and routes fetch to controlled
// JSON, per the pattern in console-connect-account.test.ts / console-render-account.test.ts.
import { describe, it, expect } from "vitest";
import { loadConsole } from "./console-harness.js";

// Operator-facing copy must never leak engineer jargon - the same bar console-connect-account.test.ts
// holds openConnectAccount() to, extended with "jwt" since this surface is closer to auth.
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

describe("console (jsdom) — startSignIn() modal", () => {
  it("opens a modal offering Sign in with Google and a setup-code fallback", () => {
    const { doc, c } = loadConsole();
    c.startSignIn();
    const card = doc.querySelector(".wz-card");
    expect(card).not.toBeNull();
    expect(doc.querySelector("#wz-signin-google")).not.toBeNull();
    expect(doc.querySelector("#wz-signin-code")).not.toBeNull();
    expect(card!.textContent).toContain("Sign in with Google");
    expect(card!.textContent).toContain("Have a setup code?");
    // The "Email me a link" button was removed - there is no email-magic-link backend, and the
    // daemon's /api/signin reads no request body so it can't tell email apart from Google anyway.
    expect(doc.querySelector("#wz-signin-email")).toBeNull();
    expect(doc.querySelector("#wz-signin-emailgo")).toBeNull();
    expect(card!.textContent).not.toContain("Email me a link");
    // operator copy only - no engineer jargon leaks into the dialog
    expect(card!.textContent).not.toMatch(BANNED);
  });

  it("'Have a setup code?' closes the sign-in modal and falls back to the existing connect flow", () => {
    const { doc, c } = loadConsole();
    c.startSignIn();
    (doc.querySelector("#wz-signin-code") as unknown as { click(): void }).click();
    expect(doc.querySelector(".signin-modal")).toBeNull(); // the sign-in modal tore down
    expect(doc.querySelector("#wz-connect")).not.toBeNull(); // openConnectAccount()'s modal is up
    expect(doc.querySelector("#wz-baseurl")).not.toBeNull();
  });

  it("Cancel closes the modal without posting anything", () => {
    const { doc, w, c } = loadConsole();
    let posted = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (w as any).fetch = (_url: string, opts: any) => {
      if (opts && opts.method === "POST") posted = true;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    };
    c.startSignIn();
    (doc.querySelector('.signin-modal [data-a="cancel"]') as unknown as { click(): void }).click();
    expect(doc.querySelector(".signin-modal")).toBeNull();
    expect(posted).toBe(false);
  });

  it("Sign in with Google POSTs {provider:'google'} to /api/signin and, on connected, tears down + refreshes the rail", async () => {
    const { doc, w, c } = loadConsole();
    let posted: unknown = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (w as any).fetch = (url: string, opts: any) => {
      const u = String(url);
      if (u.includes("/api/signin") && opts && opts.method === "POST") {
        posted = JSON.parse(opts.body);
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ state: "connected" }) });
      }
      if (u.includes("/api/projects")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ projects: [{ id: "p1", name: "Workspace", items: [] }] }) });
      if (u.includes("/api/sessions")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ sessions: [] }) });
      if (u.includes("/api/sync")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ status: "ok", unsaved: { files: 0, oldestAt: null, stale: false, connected: true } }) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    };
    c.startSignIn();
    (doc.querySelector("#wz-signin-google") as unknown as { click(): void }).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(posted).toEqual({ provider: "google" });
    expect(doc.querySelector(".signin-modal")).toBeNull(); // modal torn down
    expect(doc.querySelector("#convos .project")).not.toBeNull(); // refreshProjects() repainted the rail
  });

  it("on {state:'needs-help'} shows an attention message, leaves the modal up, and does not refresh", async () => {
    const { doc, w, c } = loadConsole();
    const fetched: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (w as any).fetch = (url: string, opts: any) => {
      const u = String(url);
      fetched.push(u);
      if (u.includes("/api/signin") && opts && opts.method === "POST") {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ state: "needs-help" }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    };
    c.startSignIn();
    (doc.querySelector("#wz-signin-google") as unknown as { click(): void }).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(doc.querySelector(".signin-modal")).not.toBeNull(); // modal stays up - not a "connected" state
    expect(doc.querySelector(".wz-card")!.textContent).toContain(
      "Connected, but your account needs attention - please contact your company."
    );
    // refreshProjects() was NOT invoked - it would have hit /api/projects
    expect(fetched.some((u) => u.includes("/api/projects"))).toBe(false);
    expect(doc.querySelector(".wz-card")!.textContent).not.toMatch(BANNED);
  });

  it("on {error:'sign-in not configured'} (the dormant 501) shows friendly copy, never the raw string", async () => {
    const { doc, w, c } = loadConsole();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (w as any).fetch = (url: string, opts: any) => {
      const u = String(url);
      if (u.includes("/api/signin") && opts && opts.method === "POST") {
        return Promise.resolve({ ok: false, status: 501, json: () => Promise.resolve({ error: "sign-in not configured" }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    };
    c.startSignIn();
    (doc.querySelector("#wz-signin-google") as unknown as { click(): void }).click();
    await new Promise((r) => setTimeout(r, 0));
    const text = doc.querySelector(".wz-card")!.textContent!;
    expect(text).not.toContain("sign-in not configured"); // never the raw internal string
    expect(text).toMatch(/setup code/i); // nudges toward the working fallback
    expect(text).not.toMatch(BANNED);
  });

  it("shows the returned error inline on a 4xx and leaves the form up to retry", async () => {
    const { doc, w, c } = loadConsole();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (w as any).fetch = (url: string, opts: any) => {
      const u = String(url);
      if (u.includes("/api/signin") && opts && opts.method === "POST") {
        return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ error: "We could not sign you in - please try again." }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    };
    c.startSignIn();
    (doc.querySelector("#wz-signin-google") as unknown as { click(): void }).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(doc.querySelector("#wz-signin-google")).not.toBeNull(); // form still up
    expect(doc.querySelector(".wz-card")!.textContent).toMatch(/could not sign you in/i);
  });

  it("does not stack a second modal on a repeat call", () => {
    const { doc, c } = loadConsole();
    c.startSignIn();
    c.startSignIn();
    expect(doc.querySelectorAll(".signin-modal")).toHaveLength(1);
  });
});

describe("console (jsdom) — sign-in CTAs render only while signed out", () => {
  const routes = (connected: boolean, files: number): Array<[string, unknown]> => [
    ["/api/projects", { projects: [{ id: "p1", name: "Workspace", items: [] }] }],
    ["/api/sessions", { sessions: [] }],
    ["/api/sync", { status: "ok", unsaved: { files, oldestAt: files ? Date.now() : null, stale: false, connected } }],
    ["/api/pending", { cards: [] }],
  ];

  it("signed out with local work: the left-rail pill AND the pending card both render", async () => {
    const { doc, w, c } = loadConsole();
    routeFetch(w, routes(false, 3));
    await c.refreshProjects();
    const pill = doc.querySelector("#signinCta .signin-pill");
    expect(pill).not.toBeNull();
    expect(pill!.textContent).toContain("Back up & sync");
    expect(pill!.textContent).not.toMatch(BANNED);

    c.S.rightTab = "pending";
    await c.rPending();
    const card = doc.querySelector("#rpanel .pcard.save");
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain("Sign in");
    expect(card!.textContent).not.toMatch(BANNED);
  });

  it("signed in: neither the pill nor the sign-in pending card renders", async () => {
    const { doc, w, c } = loadConsole();
    routeFetch(w, routes(true, 0));
    await c.refreshProjects();
    expect(doc.querySelector("#signinCta .signin-pill")).toBeNull();
    expect(doc.querySelector("#signinCta")!.getAttribute("hidden")).not.toBeNull();

    c.S.rightTab = "pending";
    await c.rPending();
    expect(doc.querySelector("#rpanel .pcard.save")).toBeNull(); // fully saved - no card at all

    // Even with local work outstanding, a CONNECTED account gets the normal "Save your work" card
    // (unrelated to sign-in), never the sign-in variant.
    routeFetch(w, routes(true, 3));
    await c.rPending();
    expect(doc.querySelector("#rpanel .pcard.save.signin")).toBeNull();
    expect(doc.querySelector("#rpanel #signin-now")).toBeNull();
    expect(doc.querySelector("#rpanel #save-now")).not.toBeNull();
  });

  it("clicking either CTA opens the sign-in modal", async () => {
    const { doc, w, c } = loadConsole();
    routeFetch(w, routes(false, 3));
    await c.refreshProjects();
    (doc.querySelector("#signinCta .signin-pill") as unknown as { click(): void }).click();
    expect(doc.querySelector(".signin-modal")).not.toBeNull();
    (doc.querySelector('.signin-modal [data-a="cancel"]') as unknown as { click(): void }).click();

    c.S.rightTab = "pending";
    await c.rPending();
    (doc.querySelector("#rpanel #signin-now") as unknown as { click(): void }).click();
    expect(doc.querySelector(".signin-modal")).not.toBeNull();
  });
});
