/**
 * A block's entry in a hosted revision index (`revisions/<id>/index.json`,
 * `latest.json`): its version plus the small metadata routing and the
 * reference walk need without reading the body (contract §2.1).
 *
 * - `type`: the body's raw `__resolveType` (no alias mapping);
 * - `path`: the body's top-level `path` string, whatever the type;
 * - `refs`: every `__resolveType` string anywhere in the body (every
 *   variant, `never` and `lazy` included, the top-level one too) that is a
 *   block name of the index being built, deduped, code-unit sorted.
 *
 * Each key is present only when non-empty; an entry carries `meta` only when
 * it has a key, and `data` (the body) only for the CMS settings block.
 *
 * `@decocms/blocks/protocol`'s own `blockMeta` (on the `cdn-cms/cas` branch)
 * is the same function. No release carries it yet, and Studio can't take it
 * from the branch without publishing a package (see `block-version.ts`), so
 * this is a copy, checked against the byte-identical
 * `block-meta-vectors.json`. Swap it for the package's export once released.
 */

import { blockVersion } from "./block-version";

export interface BlockMeta {
  type?: string;
  path?: string;
  refs?: string[];
}

export interface IndexEntry {
  version: string;
  meta?: BlockMeta;
  data?: unknown;
}

export type BlockIndex = Record<string, IndexEntry>;

/** The settings block, whose body every index inlines. */
const CMS_SETTINGS_BLOCK = "CMS";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function collectResolveTypes(value: unknown, out: Set<string>) {
  if (Array.isArray(value)) {
    for (const item of value) collectResolveTypes(item, out);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, inner] of Object.entries(value)) {
    if (key === "__resolveType" && typeof inner === "string") out.add(inner);
    else collectResolveTypes(inner, out);
  }
}

export function blockMeta(
  body: unknown,
  names: ReadonlySet<string> | readonly string[],
): BlockMeta {
  if (!isPlainObject(body)) return {};
  const known: ReadonlySet<string> =
    names instanceof Set ? names : new Set(names as readonly string[]);
  const meta: BlockMeta = {};
  if (typeof body.__resolveType === "string") meta.type = body.__resolveType;
  if (typeof body.path === "string") meta.path = body.path;
  const found = new Set<string>();
  collectResolveTypes(body, found);
  const refs = [...found].filter((name) => known.has(name)).sort();
  if (refs.length > 0) meta.refs = refs;
  return meta;
}

export function indexEntry(
  name: string,
  body: unknown,
  names: ReadonlySet<string> | readonly string[],
): IndexEntry {
  const meta = blockMeta(body, names);
  return {
    version: blockVersion(body),
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
    ...(name === CMS_SETTINGS_BLOCK ? { data: body } : {}),
  };
}
