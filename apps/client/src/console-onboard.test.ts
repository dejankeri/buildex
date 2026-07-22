// Browser test net for the first-run "name your company" dialog (Task 5): the very first screen a
// fresh operator sees, before any local work exists. Loads the REAL bundle into jsdom (see
// console-harness.ts) and routes fetch to controlled JSON, per the pattern in
// console-signin.test.ts.
import { describe, it, expect } from "vitest";
import { loadConsole } from "./console-harness.js";

// Operator-facing copy must never leak engineer jargon - the same bar startSignIn() is held to in
// console-signin.test.ts, extended with "jwt" since this surface is closer to auth.
const BANNED = /\b(push|commit|branch|merge|diff|token|jwt)\b/i;

describe("console (jsdom) — openOnboard() first-run dialog", () => {
  it("with signInAvailable:true shows the Company name field and both options, cloud selected by default", async () => {
    const { doc, w, c } = loadConsole();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (w as any).fetch = (url: string) => {
      const u = String(url);
      if (u.includes("/api/sync")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ status: "ok", unsaved: { files: 0, oldestAt: null, stale: false, connected: false }, signInAvailable: true }),
        });
      }
      return Promise.reject(new Error("no route: " + u));
    };
    // Fire-and-forget: openOnboard()'s promise now resolves only on dismiss (see the resolution-
    // timing tests below), so this test - which only inspects the drawn dialog and never dismisses
    // it - must not await it to completion. A tick is enough for the initial GET /api/sync + draw().
    c.openOnboard();
    await new Promise((r) => setTimeout(r, 0));
    const card = doc.querySelector(".wz-card");
    expect(card).not.toBeNull();
    expect(doc.querySelector("#wz-company-name")).not.toBeNull();
    const cloudOpt = doc.querySelector('input[name="wz-onboard-mode"][value="cloud"]') as unknown as { checked: boolean };
    const localOpt = doc.querySelector('input[name="wz-onboard-mode"][value="local"]') as unknown as { checked: boolean };
    expect(cloudOpt).not.toBeNull();
    expect(localOpt).not.toBeNull();
    expect(cloudOpt.checked).toBe(true); // cloud is the default/selected option
    expect(localOpt.checked).toBe(false);
    const text = card!.textContent!;
    expect(text).toContain("Back up to the cloud");
    expect(text).toContain("Keep everything on this device");
    expect(text).toMatch(/link Google later/i); // the nudge toward linking a real identity later
    expect(text).toMatch(/you risk losing it/i); // honest local-only warning
    expect(text).not.toMatch(BANNED);
  });

  it("with signInAvailable:false shows NO cloud option - local-only", async () => {
    const { doc, w, c } = loadConsole();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (w as any).fetch = (url: string) => {
      const u = String(url);
      if (u.includes("/api/sync")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ status: "ok", unsaved: { files: 0, oldestAt: null, stale: false, connected: false }, signInAvailable: false }),
        });
      }
      return Promise.reject(new Error("no route: " + u));
    };
    // Fire-and-forget - see the note in the previous test: this dialog is never dismissed here.
    c.openOnboard();
    await new Promise((r) => setTimeout(r, 0));
    const card = doc.querySelector(".wz-card");
    expect(card).not.toBeNull();
    expect(doc.querySelector("#wz-company-name")).not.toBeNull();
    expect(doc.querySelector('input[name="wz-onboard-mode"]')).toBeNull();
    expect(card!.textContent).not.toContain("Back up to the cloud");
    expect(card!.textContent).not.toMatch(BANNED);
  });

  it("cloud submit with a name POSTs /api/onboard {companyName} and, on connected, tears down + refreshes - WITHOUT marking onboarding complete; the returned promise stays pending until then", async () => {
    const { doc, w, c } = loadConsole();
    let posted: unknown = null;
    let completePosted = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (w as any).fetch = (url: string, opts: any) => {
      const u = String(url);
      // /api/onboarding/complete's URL also contains the substring "/api/onboard" - check it FIRST
      // so it doesn't shadow the actual POST /api/onboard route below.
      if (u.includes("/api/onboarding/complete")) { completePosted = true; return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }); }
      if (u.includes("/api/onboard") && opts && opts.method === "POST") {
        posted = JSON.parse(opts.body);
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ state: "connected" }) });
      }
      if (u.includes("/api/sync")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ status: "ok", unsaved: { files: 0, oldestAt: null, stale: false, connected: true }, signInAvailable: true }),
        });
      }
      if (u.includes("/api/projects")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ projects: [{ id: "p1", name: "Workspace", items: [] }] }) });
      if (u.includes("/api/sessions")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ sessions: [] }) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    };
    let resolved = false;
    c.openOnboard().then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 0)); // let the initial GET /api/sync + draw() settle
    expect(doc.querySelector(".wz-card")).not.toBeNull(); // drawn...
    expect(resolved).toBe(false); // ...but NOT resolved merely because it's drawn (the bug this guards against)
    (doc.querySelector("#wz-company-name") as unknown as { value: string }).value = "Acme Co.";
    (doc.querySelector("#wz-onboard-continue") as unknown as { click(): void }).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(posted).toEqual({ companyName: "Acme Co." });
    expect(doc.querySelector(".onboard-modal")).toBeNull(); // torn down
    expect(doc.querySelector("#convos .project")).not.toBeNull(); // refreshProjects() repainted the rail
    // openOnboard() must NOT mark onboarding complete - that's the wizard's (checkOnboarding's) job,
    // and it runs AFTER this dialog closes, so it still needs to see firstRun:true.
    expect(completePosted).toBe(false);
    expect(resolved).toBe(true); // NOW resolved - safe for boot.js to run checkOnboarding() next
  });

  it("empty company name shows an inline message and never POSTs", async () => {
    const { doc, w, c } = loadConsole();
    let posted = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (w as any).fetch = (url: string, opts: any) => {
      const u = String(url);
      if (opts && opts.method === "POST") posted = true;
      if (u.includes("/api/sync")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ status: "ok", unsaved: { files: 0, oldestAt: null, stale: false, connected: false }, signInAvailable: true }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    };
    // Fire-and-forget: the empty-name path redraws with an error and never dismisses, so the
    // returned promise never resolves in this test.
    c.openOnboard();
    await new Promise((r) => setTimeout(r, 0));
    (doc.querySelector("#wz-onboard-continue") as unknown as { click(): void }).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(posted).toBe(false);
    expect(doc.querySelector(".wz-card")!.textContent).toMatch(/enter a company name/i);
    expect(doc.querySelector(".onboard-modal")).not.toBeNull(); // dialog stays up
  });

  it("submitting local proceeds without posting to /api/onboard or /api/onboarding/complete", async () => {
    const { doc, w, c } = loadConsole();
    let onboardPosted = false;
    let completePosted = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (w as any).fetch = (url: string, opts: any) => {
      const u = String(url);
      if (u.includes("/api/onboarding/complete")) completePosted = true;
      else if (u.includes("/api/onboard") && opts && opts.method === "POST") onboardPosted = true;
      if (u.includes("/api/sync")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ status: "ok", unsaved: { files: 0, oldestAt: null, stale: false, connected: false }, signInAvailable: true }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    };
    // Fire-and-forget: awaiting to completion here would deadlock, since the promise only
    // resolves once the "Continue" click below dismisses the dialog.
    c.openOnboard();
    await new Promise((r) => setTimeout(r, 0));
    (doc.querySelector('input[name="wz-onboard-mode"][value="local"]') as unknown as { checked: boolean; click(): void }).click();
    (doc.querySelector("#wz-onboard-continue") as unknown as { click(): void }).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(onboardPosted).toBe(false);
    // openOnboard() must NOT mark onboarding complete on the local path either - the wizard
    // (checkOnboarding) still needs to run its full step sequence afterward.
    expect(completePosted).toBe(false);
    expect(doc.querySelector(".onboard-modal")).toBeNull(); // torn down
  });

  it("returned promise is still pending right after the dialog is drawn, and resolves only on dismiss (local-only path) - boot.js's `await openOnboard(); checkOnboarding();` must not stack the wizard on top of a still-open dialog", async () => {
    const { doc, w, c } = loadConsole();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (w as any).fetch = (url: string) => {
      const u = String(url);
      if (u.includes("/api/sync")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ status: "ok", unsaved: { files: 0, oldestAt: null, stale: false, connected: false }, signInAvailable: false }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    };
    let resolved = false;
    c.openOnboard().then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 0)); // let the initial GET /api/sync + draw() settle
    expect(doc.querySelector(".wz-card")).not.toBeNull(); // drawn...
    expect(resolved).toBe(false); // ...but NOT resolved yet - it must wait for dismissal, not just drawing
    (doc.querySelector("#wz-onboard-continue") as unknown as { click(): void }).click(); // "Continue" tears down (local-only)
    await new Promise((r) => setTimeout(r, 0));
    expect(doc.querySelector(".onboard-modal")).toBeNull(); // torn down
    expect(resolved).toBe(true); // NOW resolved
  });

  it("does not stack a second modal on a repeat call", async () => {
    const { doc, w, c } = loadConsole();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (w as any).fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ signInAvailable: false }) });
    // Fire-and-forget the first call - it's never dismissed, so its promise never resolves here.
    c.openOnboard();
    await new Promise((r) => setTimeout(r, 0));
    // The repeat call hits the re-entry guard and resolves immediately (it never opens a second
    // dialog to dismiss), so awaiting it is safe.
    await c.openOnboard();
    expect(doc.querySelectorAll(".onboard-modal")).toHaveLength(1);
  });
});
