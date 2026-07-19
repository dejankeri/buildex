// The source of capability-pack DEFINITIONS for the App Store. Definitions are app-version data -
// they ship WITH the app - not operator data, so they come from the bundled core pack read LIVE on
// every store open, never from a copy frozen into the operator's workspace at provisioning time
// (which went stale across app updates - the bug this seam fixes). Installed-STATE stays derived from
// the workspace roots (see catalog.ts); this module only supplies the catalogue of what's available.
//
// The interface is filesystem-shaped on purpose: install copies a pack's skill folders off `dir(id)`,
// so a future HTTP source just fetches-then-caches and returns the cache path behind the same
// contract - no consumer changes (invariant #10: build the seam, not the engine).
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const NAME_RE = /^[a-z][a-z0-9-]*$/;

export interface CatalogSource {
  /** Available pack ids, deterministic. Invalid names are skipped; a dir without a pack.json may still
   *  appear here (callers resolve it via `dir()`, which gates on the manifest). */
  ids(): string[];
  /** Local dir holding a pack's `pack.json` + `skills/`, or undefined when the pack is absent or its
   *  manifest is missing. Callers read the manifest and copy skill folders from this path. */
  dir(id: string): string | undefined;
}

/** A catalog served from a local `catalog/` dir - the bundled core pack (`<resources>/core-pack/catalog`
 *  in a packaged app, `packs/core/catalog` in dev). Read live on every call, so an app update that
 *  ships a new bundle changes the store immediately with no re-provisioning. */
export function bundleCatalogSource(catalogDir: string): CatalogSource {
  return {
    ids() {
      if (!existsSync(catalogDir)) return [];
      return readdirSync(catalogDir).filter(
        (id) => NAME_RE.test(id) && statSync(join(catalogDir, id)).isDirectory(),
      );
    },
    dir(id) {
      if (!NAME_RE.test(id)) return undefined;
      const d = join(catalogDir, id);
      return existsSync(join(d, "pack.json")) ? d : undefined;
    },
  };
}

/** A catalog with no packs - the safe default when a boot wires no source. An empty store, never a
 *  stale one. */
export function emptyCatalogSource(): CatalogSource {
  return { ids: () => [], dir: () => undefined };
}
