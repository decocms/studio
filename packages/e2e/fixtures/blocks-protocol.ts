/**
 * The runtime pieces of `@decocms/blocks`' content protocol the specs use.
 *
 * `@decocms/blocks` ships TypeScript sources, and Node refuses to strip types
 * under node_modules, so Playwright (which runs on Node) can't import them as
 * they are. Like the package's own `deco` bin, this registers tsx's loader
 * first and then imports them. Import types from `@decocms/blocks/*` directly
 * (`import type` is erased); import values from here.
 */

import { register } from "tsx/esm/api";

register();

type Server = typeof import("@decocms/blocks/protocol/server");
type FsStorage = typeof import("@decocms/blocks/protocol/storage/fs");
type Conformance = typeof import("@decocms/blocks/protocol/conformance");

const server: Server = await import("@decocms/blocks/protocol/server");
const fsStorage: FsStorage = await import(
  "@decocms/blocks/protocol/storage/fs"
);
const conformance: Conformance = await import(
  "@decocms/blocks/protocol/conformance"
);

export const createContentHandler: Server["createContentHandler"] =
  server.createContentHandler;
export const createFsStorage: FsStorage["createFsStorage"] =
  fsStorage.createFsStorage;
export const runConformance: Conformance["runConformance"] =
  conformance.runConformance;
