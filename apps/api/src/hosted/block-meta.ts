/**
 * Index entries of a hosted release (see /next/hosted-releases-internals):
 * `revisions/<id>/index.json` and `latest.json` map each block name to its
 * hash (`version`) plus the little metadata routing and the reference walk
 * need, so neither needs a block body.
 *
 * `blockMeta(body, names)` is the one helper Studio, the SDK and the CLI use
 * to compute that metadata, so all three write and read the same entries.
 * Pure, synchronous, browser-safe; its only import is the dependency-free
 * canonical hash (for `indexEntry`).
 *
 * - `type`: the body's raw top-level `__resolveType`, copied without alias
 *   mapping (readers map it with their alias rules).
 * - `path`: the body's top-level `path`, when it is a string (any type).
 * - `refs`: every `__resolveType` string anywhere in the body (the top-level
 *   one included, every variant, `never` and `lazy` values included) that is
 *   one of `names`, deduped and sorted in code-unit order.
 *
 * A key is present only when it has a value (`refs: []` is left out), so a
 * body with nothing to say gives `{}` and its entry carries no `meta`.
 */
import { blockVersion } from "./canonical.ts";

/** What an index says about a block, besides its hash. */
export interface BlockMeta {
  /** The body's raw `__resolveType`. */
  type?: string;
  /** The body's top-level `path`. */
  path?: string;
  /** The block names the body references, deduped, in code-unit order. */
  refs?: string[];
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

/** The metadata of one block body; `names` are the block names of the index being built. */
export function blockMeta(
  body: unknown,
  names: ReadonlySet<string> | readonly string[],
): BlockMeta {
  const meta: BlockMeta = {};
  if (!isRecord(body)) return meta;
  if (typeof body.__resolveType === "string") meta.type = body.__resolveType;
  if (typeof body.path === "string") meta.path = body.path;
  const known: ReadonlySet<string> = isSet(names) ? names : new Set(names);
  const found = new Set<string>();
  collectRefs(body, known, found);
  if (found.size > 0) meta.refs = [...found].sort();
  return meta;
}

/** The index entry for a block: its hash, its metadata when any, and its body when it is `CMS`. */
export async function indexEntry(
  name: string,
  body: unknown,
  names: ReadonlySet<string> | readonly string[],
): Promise<IndexEntry> {
  const entry: IndexEntry = { version: await blockVersion(body) };
  const meta = blockMeta(body, names);
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
