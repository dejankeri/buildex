// Browser test net for the operator console — OS notifications. jsdom has no Notification, which is
// exactly the condition a plain browser tab on an insecure origin presents, so the "unsupported"
// path is covered by doing nothing special; a fake constructor stands in for the granted case.
//
// Two rules carry the whole feature and are pinned hardest here: nothing fires while BuildEx has
// focus, and nothing fires that the operator did not switch on. Everything else is copy.
import { describe, it, expect, beforeEach } from "vitest";
import { loadConsole, type ConsoleHandle } from "./console-harness.js";

interface FakeNote {
  title: string;
  opts: Record<string, unknown>;
  onclick: (() => void) | null;
  closed: boolean;
}

/**
 * Put a Notification stand-in on the jsdom window and report what gets raised.
 * @param permission - what the OS is pretending to have answered.
 */
function fakeNotification(handle: ConsoleHandle, permission: string) {
  const raised: FakeNote[] = [];
  let asked = 0;
  class N {
    onclick: (() => void) | null = null;
    closed = false;
    constructor(
      public title: string,
      public opts: Record<string, unknown> = {},
    ) {
      raised.push(this as unknown as FakeNote);
    }
    close() {
      this.closed = true;
    }
    static permission = permission;
    static requestPermission() {
      asked++;
      return Promise.resolve("granted");
    }
  }
  (handle.w as unknown as Record<string, unknown>)["Notification"] = N;
  return { raised, asks: () => asked };
}

/** Pretend the operator is looking at something else - the only state a notification fires in.
 *  jsdom's own answer to hasFocus()/hidden is not a browser's, so both cases are set explicitly. */
function blur(handle: ConsoleHandle) {
  const doc = handle.doc as unknown as Record<string, unknown>;
  doc["hasFocus"] = () => false;
  Object.defineProperty(doc, "hidden", { value: true, configurable: true });
}

/** Pretend BuildEx is the window in front of the operator. */
function focusApp(handle: ConsoleHandle) {
  const doc = handle.doc as unknown as Record<string, unknown>;
  doc["hasFocus"] = () => true;
  Object.defineProperty(doc, "hidden", { value: false, configurable: true });
}

/** The bits of a jsdom element these tests touch. The project deliberately has no DOM lib (see
 *  jsdom-shim.d.ts), so the harness's consumers name what they use. */
interface Host {
  append(...nodes: unknown[]): void;
  textContent: string;
  querySelector(sel: string): unknown;
}

let h: ConsoleHandle;
beforeEach(() => {
  h = loadConsole();
  (h.w as unknown as { localStorage: Storage }).localStorage.clear();
});

describe("notifications — permission and preference", () => {
  it("reports 'unsupported' where the API does not exist, and never throws reaching for it", () => {
    blur(h);
    expect(h.c.notifySupported()).toBe(false);
    expect(h.c.notifyPermission()).toBe("unsupported");
    expect(h.c.notifyOperator("loops", { title: "x" })).toBe(false);
  });

  it("defaults every kind ON, because permission is what the operator actually consented to", () => {
    expect(h.c.notifyPrefs()).toEqual({ loops: true, chat: true });
  });

  it("remembers a kind switched off", () => {
    h.c.setNotifyPref("chat", false);
    expect(h.c.notifyPrefs()).toEqual({ loops: true, chat: false });
    expect(h.c.notifyPrefs().chat).toBe(false);
  });

  it("treats a corrupt preference as the default rather than failing to notify", () => {
    (h.w as unknown as { localStorage: Storage }).localStorage.setItem("buildex.notify", "{not json");
    expect(h.c.notifyPrefs()).toEqual({ loops: true, chat: true });
  });

  it("asks the OS only when told to, and never on load", () => {
    const fake = fakeNotification(h, "default");
    expect(fake.asks()).toBe(0);
    return h.c.enableNotifications().then((state: string) => {
      expect(state).toBe("granted");
      expect(fake.asks()).toBe(1);
    });
  });
});

describe("notifications — when one actually fires", () => {
  it("says NOTHING while BuildEx has focus - the operator can already see it", () => {
    const fake = fakeNotification(h, "granted");
    focusApp(h);
    expect(h.c.notifyOperator("loops", { title: "Weekly review needs you" })).toBe(false);
    expect(fake.raised).toHaveLength(0);
  });

  it("falls back to an in-app toast when the caller asks for one and BuildEx is in front", () => {
    fakeNotification(h, "granted");
    focusApp(h);
    expect(h.c.notifyOperator("loops", { title: "Weekly review needs you", body: "It tried to send an email.", whenFocused: "toast" })).toBe(true);
    expect((h.doc.querySelector(".toast") as unknown as { textContent: string }).textContent).toBe(
      "Weekly review needs you — It tried to send an email.",
    );
  });

  it("raises a real notification once the operator has left the app", () => {
    const fake = fakeNotification(h, "granted");
    blur(h);
    expect(h.c.notifyOperator("loops", { title: "Weekly review needs you", body: "It tried to send an email.", tag: "loop-weekly-review" })).toBe(true);
    expect(fake.raised).toHaveLength(1);
    expect(fake.raised[0]!.title).toBe("Weekly review needs you");
    expect(fake.raised[0]!.opts).toMatchObject({ body: "It tried to send an email.", tag: "loop-weekly-review" });
  });

  it("stays silent for a kind the operator switched off", () => {
    const fake = fakeNotification(h, "granted");
    blur(h);
    h.c.setNotifyPref("loops", false);
    expect(h.c.notifyOperator("loops", { title: "x" })).toBe(false);
    expect(h.c.notifyOperator("chat", { title: "y" })).toBe(true); // the other kind is untouched
    expect(fake.raised).toHaveLength(1);
  });

  it("stays silent while the OS has not granted permission", () => {
    for (const state of ["default", "denied"]) {
      const fresh = loadConsole();
      const fake = fakeNotification(fresh, state);
      blur(fresh);
      expect(fresh.c.notifyOperator("loops", { title: "x" })).toBe(false);
      expect(fake.raised).toHaveLength(0);
    }
  });

  it("runs the caller's action on click and closes itself", () => {
    const fake = fakeNotification(h, "granted");
    blur(h);
    let opened = 0;
    h.c.notifyOperator("loops", { title: "x", onClick: () => opened++ });
    fake.raised[0]!.onclick!();
    expect(opened).toBe(1);
    expect(fake.raised[0]!.closed).toBe(true);
  });
});

describe("notifications — the enable flow", () => {
  it("offers the nudge only while the operator has not answered", () => {
    fakeNotification(h, "default");
    expect(h.c.notifyNudge()).not.toBeNull();
    for (const state of ["granted", "denied"]) {
      const fresh = loadConsole();
      fakeNotification(fresh, state);
      expect(fresh.c.notifyNudge()).toBeNull();
    }
  });

  it("offers nothing at all where notifications are unsupported", () => {
    expect(h.c.notifyNudge()).toBeNull();
  });

  it("names the OS's answer first, because every toggle below is meaningless without it", () => {
    const states: Record<string, string> = {
      granted: "BuildEx can notify you",
      denied: "blocking notifications",
      default: "has not asked your system yet",
      unsupported: "cannot show system notifications",
    };
    for (const [state, phrase] of Object.entries(states)) {
      const fresh = loadConsole();
      if (state !== "unsupported") fakeNotification(fresh, state);
      const host = fresh.doc.createElement("div") as unknown as Host;
      host.append(...fresh.c.notifySettingsBody({ close() {}, repaint() {} }));
      expect(host.textContent).toContain(phrase);
    }
  });

  it("offers the Turn on button only when the OS has not been asked yet", () => {
    fakeNotification(h, "default");
    const unasked = h.doc.createElement("div") as unknown as Host;
    unasked.append(...h.c.notifySettingsBody({ close() {}, repaint() {} }));
    expect(unasked.querySelector(".ns-ask")).not.toBeNull();

    const granted = loadConsole();
    fakeNotification(granted, "granted");
    const done = granted.doc.createElement("div") as unknown as Host;
    done.append(...granted.c.notifySettingsBody({ close() {}, repaint() {} }));
    expect(done.querySelector(".ns-ask")).toBeNull();
  });

  it("writes a toggled kind straight through to the preference", () => {
    fakeNotification(h, "granted");
    const host = h.doc.createElement("div") as unknown as Host;
    host.append(...h.c.notifySettingsBody({ close() {}, repaint() {} }));
    const box = host.querySelector('.ns-cb[data-kind="chat"]') as unknown as { checked: boolean; onchange: (e: unknown) => void };
    expect(box.checked).toBe(true);
    box.checked = false;
    box.onchange({ target: box });
    expect(h.c.notifyPrefs().chat).toBe(false);
  });

  it("is honest that a closed BuildEx cannot notify anyone", () => {
    fakeNotification(h, "granted");
    const host = h.doc.createElement("div") as unknown as Host;
    host.append(...h.c.notifySettingsBody({ close() {}, repaint() {} }));
    expect(host.textContent).toContain("BuildEx must be running");
  });
});

describe("notifications — what the Loops panel announces", () => {
  /** Seed a previous poll, run the next one through the differ, and report what was raised. */
  function poll(before: unknown[] | undefined, after: unknown[]) {
    const fake = fakeNotification(h, "granted");
    blur(h);
    h.c.noticeLoopChanges(before, after);
    return fake.raised;
  }

  const ok = { name: "weekly-review", title: "Weekly review", status: "ok", lastRun: 100, sessionId: "s1" };

  it("announces a run that ended needing the operator, naming what it tried", () => {
    const raised = poll([ok], [{ ...ok, status: "needs-approval", lastRun: 200, blockedOn: "send an email to ops@acme.com" }]);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.title).toBe("Weekly review needs you");
    expect(raised[0]!.opts["body"]).toBe("It tried to send an email to ops@acme.com.");
  });

  it("announces a failure", () => {
    expect(poll([ok], [{ ...ok, status: "failed", lastRun: 200 }])[0]!.title).toBe("Weekly review failed");
  });

  it("says nothing about a run that finished cleanly", () => {
    expect(poll([{ ...ok, status: "running" }], [{ ...ok, lastRun: 200 }])).toHaveLength(0);
  });

  it("announces a TRANSITION only - a loop already blocked when we last looked is old news", () => {
    const blocked = { ...ok, status: "needs-approval", lastRun: 200, blockedOn: "send an email" };
    expect(poll([blocked], [blocked])).toHaveLength(0);
  });

  it("says nothing on the first poll, so a reload does not replay yesterday", () => {
    expect(poll(undefined, [{ ...ok, status: "needs-approval" }])).toHaveLength(0);
  });

  it("says nothing about a loop it is seeing for the first time", () => {
    expect(poll([], [{ ...ok, status: "failed" }])).toHaveLength(0);
  });

  it("collapses repeats of the same loop onto one notification rather than stacking twenty", () => {
    const raised = poll([ok], [{ ...ok, status: "failed", lastRun: 200 }]);
    expect(raised[0]!.opts["tag"]).toBe("loop-weekly-review");
  });
});
