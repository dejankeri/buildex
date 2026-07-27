import path from 'node:path'

// Where the shipped capability-pack catalog lives. It travels with the binary
// via electron-builder's extraResources (`resources/buildex/catalog` ->
// `<resources>/buildex/catalog`), which means a brand-new operator with an empty
// company repo still opens the Store to a full shelf, and an app update also
// carries newer skills for packs they already installed.
//
// Kept free of `electron` so the catalog layer stays unit-testable; the caller
// supplies the resource root (see src/main/ipc/buildex-packs.ts).

export const BUNDLED_CATALOG_SUBPATH = path.join('buildex', 'catalog')

export function buildexCatalogRootFrom(resourceRoot: string): string {
  return path.join(resourceRoot, BUNDLED_CATALOG_SUBPATH)
}
