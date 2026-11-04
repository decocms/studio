/**
 * The hosted CMS's release objects on the delivery bucket (contract §2):
 *
 *   latest.json                   { revision, previewHosts }: the one pointer
 *   revisions/<id>/data.json      { blocks }: immutable, `\uXXXX`-escaped
 *   revisions/<id>/meta.json      who published it, how, why, when, and the
 *                                 revision before it (`previous`)
 *
 * Reads go through the R2 API (strong reads). A revision's blocks are
 * immutable, so each Studio process caches them by id (with each block's
 * file, text and version, computed once), in place of the git blob cache.
 */

import {
  blockFileName,
  serializeBlock,
  spellingKey,
  type StorageFile,
} from "@decocms/blocks/protocol";
import { createTtlLruCache } from "@/lib/ttl-lru-cache";
import type { CmsVia } from "@/storage/types";
import { blockVersion } from "./block-version";
import {
  CACHE_LATEST,
  CACHE_REVISION,
  type DeliveryStore,
  deliveryKeys,
  type PutCondition,
} from "./delivery-store";
import { isRevisionId } from "./revision-id";

export interface LatestPointer {
  revision: string;
  previewHosts: string[];
}

export type Blocks = Record<string, unknown>;

/** A revision's `meta.json` (contract §2.3). */
export interface RevisionMeta {
  previous: string | null;
  draft?: string;
  reapplyOf?: string;
  author: string;
  via: CmsVia;
  message: string;
  publishedAt: string;
}

/** latest.json is not what this Studio writes: nothing is decided on it. */
export class MalformedObjectError extends Error {
  constructor(key: string) {
    super(`${key} is malformed`);
    this.name = "MalformedObjectError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** latest.json with its ETag (for the `If-Match` write), or null when none. */
export async function readLatestPointer(
  store: DeliveryStore,
  site: string,
): Promise<{ pointer: LatestPointer; etag: string | null } | null> {
  const key = deliveryKeys.latest(site);
  const object = await store.get(key);
  if (!object) return null;
  let value: unknown;
  try {
    value = JSON.parse(object.text);
  } catch {
    throw new MalformedObjectError(key);
  }
  if (!isRecord(value) || !isRevisionId(value.revision)) {
    throw new MalformedObjectError(key);
  }
  const hosts = Array.isArray(value.previewHosts)
    ? value.previewHosts.filter((h): h is string => typeof h === "string")
    : [];
  return {
    pointer: { revision: value.revision, previewHosts: hosts },
    etag: object.etag,
  };
}

/** Writes latest.json: `If-Match` on the ETag read, or create-only. */
export function writeLatestPointer(
  store: DeliveryStore,
  site: string,
  pointer: LatestPointer,
  etag: string | null,
) {
  const condition: PutCondition = etag
    ? { ifMatch: etag }
    : { ifNoneMatch: "*" };
  return store.putJson(
    deliveryKeys.latest(site),
    { revision: pointer.revision, previewHosts: [...pointer.previewHosts] },
    CACHE_LATEST,
    undefined,
    condition,
  );
}

/**
 * `data.json`'s text: `JSON.stringify({ blocks })`, then every UTF-16 code
 * unit above U+007F as `\uXXXX`, so the text is pure ASCII and a site
 * parses it as a one-byte string (S4: lower peak heap during a swap).
 */
export function serializeRevisionData(blocks: Blocks): string {
  return JSON.stringify({ blocks }).replace(
    /[\u0080-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** The SDK's revision cap: Studio never publishes a larger one. */
export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

/** A revision's blocks with their files and versions (immutable). */
export interface RevisionContent {
  id: string;
  blocks: Blocks;
  files: StorageFile[];
  /** File name → stored text (`serializeBlock`). */
  texts: Map<string, string>;
  /** File name → block name. */
  names: Map<string, string>;
}

export function revisionContent(id: string, blocks: Blocks): RevisionContent {
  const files: StorageFile[] = [];
  const texts = new Map<string, string>();
  const names = new Map<string, string>();
  for (const [name, block] of Object.entries(blocks)) {
    const file = blockFileName(name);
    const text = serializeBlock(block);
    texts.set(file, text);
    names.set(file, name);
    files.push({
      file,
      version: blockVersion(block),
      size: Buffer.byteLength(text),
    });
  }
  return { id, blocks, files, texts, names };
}

/** Immutable, so cached by (site, id); a few at casaevideo's ~12 MB each. */
const revisions = createTtlLruCache<RevisionContent>({
  ttlMs: 60 * 60_000,
  maxSize: 8,
});

/** The revision's content; throws when its data.json is missing. */
export async function readRevision(
  store: DeliveryStore,
  site: string,
  id: string,
): Promise<RevisionContent> {
  const key = deliveryKeys.revisionData(site, id);
  const cacheKey = `${site}\0${id}`;
  const hit = revisions.get(cacheKey);
  if (hit) return hit;
  const object = await store.get(key);
  if (!object) throw new MalformedObjectError(key);
  let value: unknown;
  try {
    value = JSON.parse(object.text);
  } catch {
    throw new MalformedObjectError(key);
  }
  if (!isRecord(value) || !isRecord(value.blocks)) {
    throw new MalformedObjectError(key);
  }
  // fromEntries: an entry named "__proto__" stays an entry.
  const content = revisionContent(
    id,
    Object.fromEntries(Object.entries(value.blocks)),
  );
  revisions.set(cacheKey, content);
  return content;
}

/** Test-only: forget cached revisions. */
export function clearRevisionCache() {
  revisions.clear();
}

const VIAS: ReadonlySet<string> = new Set([
  "studio",
  "cli",
  "token",
  "studio-agent",
]);

function parseMeta(value: unknown): RevisionMeta | null {
  if (!isRecord(value)) return null;
  const previous = value.previous;
  if (previous !== null && !isRevisionId(previous)) return null;
  if (typeof value.author !== "string") return null;
  if (typeof value.via !== "string" || !VIAS.has(value.via)) return null;
  if (typeof value.publishedAt !== "string") return null;
  return {
    previous: previous as string | null,
    ...(typeof value.draft === "string" ? { draft: value.draft } : {}),
    ...(isRevisionId(value.reapplyOf) ? { reapplyOf: value.reapplyOf } : {}),
    author: value.author,
    via: value.via as CmsVia,
    message: typeof value.message === "string" ? value.message : "",
    publishedAt: value.publishedAt,
  };
}

/** The revision's meta, or null when it has none (a publish that crashed). */
export async function readRevisionMeta(
  store: DeliveryStore,
  site: string,
  id: string,
): Promise<RevisionMeta | null> {
  const object = await store.get(deliveryKeys.revisionMeta(site, id));
  if (!object) return null;
  try {
    return parseMeta(JSON.parse(object.text));
  } catch {
    return null;
  }
}

/**
 * Writes a revision: `data.json`, then `meta.json`, each create-only. A
 * folder without `meta.json` is invisible to the Releases list.
 */
export async function writeRevision(
  store: DeliveryStore,
  site: string,
  id: string,
  data: string,
  meta: RevisionMeta,
) {
  await store.putText(
    deliveryKeys.revisionData(site, id),
    data,
    CACHE_REVISION,
    { ifNoneMatch: "*" },
  );
  await store.putJson(
    deliveryKeys.revisionMeta(site, id),
    meta,
    CACHE_REVISION,
    undefined,
    { ifNoneMatch: "*" },
  );
}

/** A draft's changes: whole blocks it sets, names it deletes. */
export interface DraftChanges {
  set: Blocks;
  delete: string[];
}

/**
 * `blocks ⊕ draft`: a set name replaces every spelling of it with the
 * draft's block under the draft's name; a delete name hides every spelling.
 * The same layering the editor and the SDK's preview apply.
 */
export function applyDraftToBlocks(
  blocks: Blocks,
  draft: DraftChanges,
): Blocks {
  const touched = new Set(
    [...Object.keys(draft.set), ...draft.delete].map(spellingKey),
  );
  const out: Array<[string, unknown]> = Object.entries(blocks).filter(
    ([name]) => !touched.has(spellingKey(name)),
  );
  for (const [name, block] of Object.entries(draft.set))
    out.push([name, block]);
  return Object.fromEntries(out);
}

/**
 * Whether the draft changes nothing over `blocks`, block by block: every
 * set block is there under that name with the same version and no other
 * spelling, and no spelling of a deleted name is.
 */
export function draftChangesNothing(
  blocks: Blocks,
  draft: DraftChanges,
): boolean {
  const groups = new Map<string, string[]>();
  for (const name of Object.keys(blocks)) {
    const key = spellingKey(name);
    groups.set(key, [...(groups.get(key) ?? []), name]);
  }
  for (const [name, block] of Object.entries(draft.set)) {
    const group = groups.get(spellingKey(name)) ?? [];
    if (group.length !== 1 || group[0] !== name) return false;
    if (blockVersion(blocks[name]) !== blockVersion(block)) return false;
  }
  return draft.delete.every((name) => !groups.has(spellingKey(name)));
}
