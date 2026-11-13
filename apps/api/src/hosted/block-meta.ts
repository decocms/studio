/**
 * Index entries of a hosted release (see /next/hosted-releases-internals):
 * `revisions/<id>/index.json` and `latest.json` map each block name to its
 * hash (`version`) plus the little metadata routing, the reference walk and
 * `client.entries()` need, so none of them needs a block body.
 *
 * `blockMeta(body, names, bodyOf?)` is the one helper Studio, the SDK and the
 * CLI use to compute that metadata, so all three write and read the same
 * entries. Pure, synchronous, browser-safe; its only import is the
 * dependency-free canonical hash (for `indexEntry`).
 *
 * - `type`: the body's raw top-level `__resolveType`, copied without alias
 *   mapping (readers map it with their alias rules).
 * - `path`: the body's top-level `path`, when it is a string (any type).
 * - `refs`: every `__resolveType` string anywhere in the body (the top-level
 *   one included, every variant, `never` and `lazy` values included) that is
 *   one of `names`, deduped and sorted in code-unit order.
 * - `noIndex`: `true` when the body is a page that asks search engines not to
 *   index it: it has a top-level string `path` and its top-level `seo` says
 *   `noIndexing: true`, inline or through the saved SEO block it references
 *   (`{ "__resolveType": "DefaultSeo" }`), which `bodyOf` looks up (see
 *   `seoNoIndex`). Written only when `true`.
 *
 * A key is present only when it has a value (`refs: []` and `noIndex: false`
 * are left out), so a body with nothing to say gives `{}` and its entry
 * carries no `meta`.
 *
 * `META_VERSION` is the version of this metadata. An index says which version
 * computed its entries (its top-level `metaVersion`; absent is 1). A reader
 * trusts a missing `noIndex` as `false` only on an index at version 2 or
 * later, and a publish that finds an older index recomputes every entry.
 */
import { blockVersion } from "./canonical.ts";

/**
 * The version of the metadata `blockMeta` computes: 1 is `type`, `path` and
 * `refs`; 2 adds `noIndex`. An index without `metaVersion` is version 1.
 */
export const META_VERSION = 2;

/** A saved block's body by name, to follow a reference (`undefined`: not known). */
export type BodyOf = (name: string) => unknown;

/** What an index says about a block, besides its hash. */
export interface BlockMeta {
  /** The body's raw `__resolveType`. */
  type?: string;
  /** The body's top-level `path`. */
  path?: string;
  /** The block names the body references, deduped, in code-unit order. */
  refs?: string[];
  /** `true` when the page says `noIndexing` (meta version 2); never written `false`. */
  noIndex?: boolean;
}

/** One entry of a revision index. */
export interface IndexEntry {
  /** `blockVersion(body)`: the hash the body is stored under (`blocks/<version>.json`). */
  version: string;
  /** Omitted when empty. */
  meta?: BlockMeta;
  /** The body itself, only on the CMS settings entry (`CMS`). */
  data?: unknown;
}

/** A revision index's blocks: block name → entry. */
export type BlockIndex = Record<string, IndexEntry>;

/** The well-known name whose body every index inlines as `data`. */
export const INLINE_BLOCK = "CMS";

/** How many saved blocks `seoNoIndex` follows, one referencing the next. */
const MAX_SEO_HOPS = 8;

/**
 * The metadata of one block body. `names` are the block names of the index
 * being built; `bodyOf` gives the bodies of the saved blocks a page's `seo`
 * may reference (without it, only an inline `seo` counts for `noIndex`).
 */
export function blockMeta(
  body: unknown,
  names: ReadonlySet<string> | readonly string[],
  bodyOf?: BodyOf,
): BlockMeta {
  const meta: BlockMeta = {};
  if (!isRecord(body)) return meta;
  if (typeof body.__resolveType === "string") meta.type = body.__resolveType;
  if (typeof body.path === "string") meta.path = body.path;
  const known: ReadonlySet<string> = isSet(names) ? names : new Set(names);
  const found = new Set<string>();
  collectRefs(body, known, found);
  if (found.size > 0) meta.refs = [...found].sort();
  if (pageNoIndex(body, bodyOf)) meta.noIndex = true;
  return meta;
}

/**
 * Whether a page body asks not to be indexed: it has a top-level string
 * `path`, and `seoNoIndex(body.seo, bodyOf)`.
 */
export function pageNoIndex(body: unknown, bodyOf?: BodyOf): boolean {
  return isRecord(body) && typeof body.path === "string" && seoNoIndex(body.seo, bodyOf);
}

/**
 * Whether a page's `seo` value says `noIndexing: true`: its own boolean
 * `noIndexing` when it has one; otherwise, when its `__resolveType` is a saved
 * block `bodyOf` knows (a saved SEO block such as `DefaultSeo`), that block's
 * answer, following up to 8 saved blocks. Anything else (no `seo`, a variant,
 * a block `bodyOf` doesn't know, a cycle) is `false`.
 */
export function seoNoIndex(seo: unknown, bodyOf?: BodyOf): boolean {
  let node = seo;
  const seen = new Set<string>();
  for (let hop = 0; hop <= MAX_SEO_HOPS; hop++) {
    if (!isRecord(node)) return false;
    if (typeof node.noIndexing === "boolean") return node.noIndexing;
    const ref = node.__resolveType;
    if (bodyOf === undefined || typeof ref !== "string" || seen.has(ref)) return false;
    seen.add(ref);
    node = bodyOf(ref);
  }
  return false;
}

/**
 * The index entry for a block: its hash, its metadata when any, and its body
 * when it is `CMS`. `bodyOf` as for `blockMeta`.
 */
export async function indexEntry(
  name: string,
  body: unknown,
  names: ReadonlySet<string> | readonly string[],
  bodyOf?: BodyOf,
): Promise<IndexEntry> {
  const entry: IndexEntry = { version: await blockVersion(body) };
  const meta = blockMeta(body, names, bodyOf);
  if (Object.keys(meta).length > 0) entry.meta = meta;
  if (name === INLINE_BLOCK) entry.data = body;
  return entry;
}

function collectRefs(node: unknown, names: ReadonlySet<string>, found: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, names, found);
    return;
  }
  if (!isRecord(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "__resolveType") {
      if (typeof value === "string" && names.has(value)) found.add(value);
    } else {
      collectRefs(value, names, found);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSet(value: ReadonlySet<string> | readonly string[]): value is ReadonlySet<string> {
  return !Array.isArray(value);
}
