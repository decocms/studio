/**
 * `@decocms/blocks/protocol/server`: the content protocol's server core.
 *
 * `createContentHandler(storage)` serves the four methods over any
 * `ContentStorage`; `createAssetHandler(storage)` serves `PUT /assets/<name>`
 * uploads. Web-standard APIs only, so both run on Node, Bun, Workers and Deno.
 */

export {
  ASSET_TYPES,
  type AssetTypeOptions,
  assetExtensions,
  assetNameForType,
  isAcceptedAssetType,
  SVG_ASSET_TYPE,
  sanitizeAssetName,
  suffixedAssetName,
} from "../assets";
export {
  type AssetHandler,
  type AssetHandlerOptions,
  createAssetHandler,
} from "./assets";
export type { AuthOptions, AuthorizeResult } from "./auth";
export type { ContentHandlerOptions } from "./core";
export { type ContentHandler, createContentHandler } from "./handler";
