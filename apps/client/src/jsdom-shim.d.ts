// Minimal ambient types for jsdom, used only by the console test harness (console-harness.ts).
// We deliberately do NOT depend on @types/jsdom: it triple-references lib="dom", which would pull the
// browser DOM globals into this Node/Electron project and break the daemon's Node `Response`/`Buffer`
// typing. `window` is `any` here; the harness narrows it to its own loose interface. This file has no
// imports/exports, so it is an ambient (global) declaration, not a module augmentation.
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string, options?: Record<string, unknown>);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readonly window: any;
  }
}
