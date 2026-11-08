/**
 * The hosted CMS's release objects on the delivery bucket (contract §1–§2):
 *
 *   blocks/<hash>.json            one block body, immutable, keyed by its
 *                                 `blockVersion`
 *   revisions/<id>/index.json     { revision, sequence, metaVersion?,
 *                                 blocks }: name → { version, meta?,
 *                                 data? }, immutable. `metaVersion` is the
 *                                 `META_VERSION` that computed every
 *                                 entry's `meta` (absent: 1, before
 *                                 `noIndex`)
 *   revisions/<id>/meta.json      who published it, how, why, when, and the
 *                                 revision before it (`previous`)
 *   latest.json                   a copy of the live index + `previewHosts`:
 *                                 the commit point
 *
 * Reads go through the R2 API (strong reads). Immutable data is cached per
 * process: parsed revision indexes and metas by (site, id), block bodies by
 * (site, hash), bounded by bytes. `latest.json` is cached by ETag and
 * revalidated (`If-None-Match`) on every read.
 */

import { createTtlLruCache } from "@/lib/ttl-lru-cache";
import type { CmsVia } from "@/storage/types";
import type { BlockIndex, IndexEntry } from "./block-meta";
import {
  CACHE_BLOCK,
  CACHE_LATEST,
  CACHE_REVISION,
  type DeliveryStore,
  deliveryKeys,
  ObjectChangedError,
  type PutCondition,
} from "./delivery-store";
import { isRevisionId } from "./revision-id";

/** A revision's index (`revisions/<id>/index.json`, contract §2.2). */
export interface RevisionIndex {
  revision: string;
  sequence: number;
  /**
   * The meta version every entry's `meta` was computed at (`META_VERSION`
   * of the Studio that wrote it); absent is 1, an index written before
   * `noIndex`. Written only when set.
   */
  metaVersion?: number;
  blocks: BlockIndex;
}

/** An index's meta version: its `metaVersion`, 1 when it has none. */
export function metaVersionOf(index: { metaVersion?: number }): number {
  return index.metaVersion ?? 1;
}

/** `latest.json`: the live revision's index plus the preview hosts (§2.3). */
export interface Latest extends RevisionIndex {
  previewHosts: string[];
}

/** A revision's `meta.json` (contract §2.4). */
export interface RevisionMeta {
  previous: string | null;
  draft?: string;
  reapplyOf?: string;
  author: string;
  via: CmsVia;
  message: string;
  publishedAt: string;
}

const MiB = 1024 * 1024;
/** The largest index Studio writes (serialized). */
export const MAX_INDEX_BYTES = 16 * MiB;
/** The largest block object Studio writes. */
export const MAX_BLOCK_BYTES = 16 * MiB;

/**
 * A delivery object is not what this Studio writes (or, for a named
 * revision, is missing): nothing is decided on it. HTTP 500 `malformed`.
 */
export class MalformedObjectError extends Error {
  constructor(key: string) {
    super(`${key} is malformed`);
    this.name = "MalformedObjectError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const VERSION_RE = /^[A-Za-z0-9_-]{22}$/;

function parseEntry(value: unknown): IndexEntry | null {
  if (!isRecord(value) || typeof value.version !== "string") return null;
  if (!VERSION_RE.test(value.version)) return null;
  const entry: IndexEntry = { version: value.version };
  if (value.meta !== undefined) {
    if (!isRecord(value.meta)) return null;
    const meta: IndexEntry["meta"] = {};
    if (typeof value.meta.type === "string") meta.type = value.meta.type;
    if (typeof value.meta.path === "string") meta.path = value.meta.path;
    if (Array.isArray(value.meta.refs)) {
      meta.refs = value.meta.refs.filter(
        (r): r is string => typeof r === "string",
      );
    }
    if (value.meta.noIndex === true) meta.noIndex = true;
    entry.meta = meta;
  }
  if (value.data !== undefined) entry.data = value.data;
  return entry;
}

/** Parses an index's text; `MalformedObjectError` for anything else. */
function parseIndex(key: string, text: string): RevisionIndex {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new MalformedObjectError(key);
  }
  if (
    !isRecord(value) ||
    !isRevisionId(value.revision) ||
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    !isRecord(value.blocks)
  ) {
    throw new MalformedObjectError(key);
  }
  const blocks: Array<[string, IndexEntry]> = [];
  for (const [name, raw] of Object.entries(value.blocks)) {
    const entry = parseEntry(raw);
    if (!entry) throw new MalformedObjectError(key);
    blocks.push([name, entry]);
  }
  // Absent or unreadable: version 1 (as the SDK reads it).
  const metaVersion =
    typeof value.metaVersion === "number" &&
    Number.isSafeInteger(value.metaVersion) &&
    value.metaVersion >= 1
      ? value.metaVersion
      : undefined;
  // fromEntries: an entry named "__proto__" stays an entry.
  return {
    revision: value.revision,
    sequence: value.sequence,
    ...(metaVersion !== undefined ? { metaVersion } : {}),
    blocks: Object.fromEntries(blocks),
  };
}

/** latest.json per site, by ETag: revalidated on every read. */
const latestCache = new Map<string, { etag: string; latest: Latest }>();

/**
 * latest.json with its ETag (for the `If-Match` write), or null before the
 * site's first publish. A strong read, conditional on the cached ETag.
 */
export async function readLatest(
  store: DeliveryStore,
  site: string,
): Promise<{ latest: Latest; etag: string | null } | null> {
  const key = deliveryKeys.latest(site);
  const cached = latestCache.get(site);
  const object = await store.get(key, { ifNoneMatch: cached?.etag ?? null });
  if (!object) {
    latestCache.delete(site);
    return null;
  }
  if ("notModified" in object) {
    if (cached) return { latest: cached.latest, etag: cached.etag };
    // A 304 for an ETag this process no longer holds: read it whole.
    return readLatestWhole(store, site);
  }
  return adoptLatest(site, key, object.text, object.etag);
}

async function readLatestWhole(store: DeliveryStore, site: string) {
  const key = deliveryKeys.latest(site);
  const object = await store.get(key);
  if (!object) return null;
  return adoptLatest(site, key, object.text, object.etag);
}

function adoptLatest(
  site: string,
  key: string,
  text: string,
  etag: string | null,
) {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new MalformedObjectError(key);
  }
  const index = parseIndex(key, text);
  const hosts =
    isRecord(value) && Array.isArray(value.previewHosts)
      ? value.previewHosts.filter((h): h is string => typeof h === "string")
      : [];
  const latest: Latest = { ...index, previewHosts: hosts };
  if (etag) latestCache.set(site, { etag, latest });
  else latestCache.delete(site);
  return { latest, etag };
}

/** The index text Studio writes: plain `JSON.stringify` (contract §2.2). */
export function serializeIndex(index: RevisionIndex): string {
  return JSON.stringify({
    revision: index.revision,
    sequence: index.sequence,
    metaVersion: index.metaVersion,
    blocks: index.blocks,
  });
}

/** latest.json's text: the revision's index, with the preview hosts. */
function serializeLatest(latest: Latest): string {
  return JSON.stringify({
    revision: latest.revision,
    sequence: latest.sequence,
    metaVersion: latest.metaVersion,
    previewHosts: [...latest.previewHosts],
    blocks: latest.blocks,
  });
}

/**
 * Writes latest.json: `If-Match` on the ETag read, or create-only. What was
 * written is this process's cached copy under its new ETag.
 */
export async function writeLatest(
  store: DeliveryStore,
  site: string,
  latest: Latest,
  etag: string | null,
) {
  const condition: PutCondition = etag
    ? { ifMatch: etag }
    : { ifNoneMatch: "*" };
  const written = await store.putText(
    deliveryKeys.latest(site),
    serializeLatest(latest),
    CACHE_LATEST,
    condition,
  );
  if (written.etag) latestCache.set(site, { etag: written.etag, latest });
  else latestCache.delete(site);
  return written;
}

/** Parsed revision indexes: immutable, so cached by (site, id). */
const indexes = createTtlLruCache<RevisionIndex>({
  ttlMs: 60 * 60_000,
  maxSize: 16,
  updateRecencyOnGet: true,
});

/** The revision's index; `MalformedObjectError` when missing or unparseable. */
export async function readRevisionIndex(
  store: DeliveryStore,
  site: string,
  id: string,
): Promise<RevisionIndex> {
  const cacheKey = `${site}\0${id}`;
  const hit = indexes.get(cacheKey);
  if (hit) return hit;
  const key = deliveryKeys.revisionIndex(site, id);
  const object = await store.get(key);
  if (!object) throw new MalformedObjectError(key);
  const index = parseIndex(key, object.text);
  if (index.revision !== id) throw new MalformedObjectError(key);
  indexes.set(cacheKey, index);
  return index;
}

/**
 * Block bodies by hash, bounded by the bytes of their text: a hash always
 * means the same body, so an entry is never invalidated, only evicted.
 */
const BODY_CACHE_BYTES = 64 * MiB;
const BODY_TTL_MS = 60 * 60_000;
const bodies = new Map<
  string,
  { body: unknown; bytes: number; expiresAt: number }
>();
let bodyBytes = 0;

function cacheBody(key: string, body: unknown, bytes: number) {
  if (bytes > BODY_CACHE_BYTES) return;
  const had = bodies.get(key);
  if (had) {
    bodies.delete(key);
    bodyBytes -= had.bytes;
  }
  bodies.set(key, { body, bytes, expiresAt: Date.now() + BODY_TTL_MS });
  bodyBytes += bytes;
  for (const [oldest, entry] of bodies) {
    if (bodyBytes <= BODY_CACHE_BYTES) break;
    bodies.delete(oldest);
    bodyBytes -= entry.bytes;
  }
}

function cachedBody(key: string): { body: unknown } | null {
  const hit = bodies.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    bodies.delete(key);
    bodyBytes -= hit.bytes;
    return null;
  }
  // Recency: a read moves it to the newest end.
  bodies.delete(key);
  bodies.set(key, hit);
  return { body: hit.body };
}

/**
 * A published block's body by its hash; `MalformedObjectError` when the
 * object is missing (an index never names a hash that wasn't written) or
 * doesn't parse.
 */
export async function readBlockBody(
  store: DeliveryStore,
  site: string,
  hash: string,
): Promise<unknown> {
  const key = deliveryKeys.block(site, hash);
  const hit = cachedBody(key);
  if (hit) return hit.body;
  const object = await store.get(key);
  if (!object) throw new MalformedObjectError(key);
  let body: unknown;
  try {
    body = JSON.parse(object.text);
  } catch {
    throw new MalformedObjectError(key);
  }
  cacheBody(key, body, object.text.length);
  return body;
}

/**
 * Writes a block object create-only. Already there (412) is fine: the key
 * is the body's hash, so the stored body is this one.
 */
export async function writeBlockObject(
  store: DeliveryStore,
  site: string,
  hash: string,
  text: string,
): Promise<void> {
  try {
    await store.putText(deliveryKeys.block(site, hash), text, CACHE_BLOCK, {
      ifNoneMatch: "*",
    });
  } catch (error) {
    if (!(error instanceof ObjectChangedError)) throw error;
  }
}

/** Test-only: forget cached indexes, metas, bodies and latest.json copies. */
export function clearRevisionCache() {
  indexes.clear();
  metas.clear();
  bodies.clear();
  bodyBytes = 0;
  latestCache.clear();
}

/**
 * A parsed meta.json is immutable too: cached by (site, id). Only one read
 * and parsed is: never a miss (404) or a read or parse failure, so a fixed
 * object is seen on the next read.
 */
const metas = createTtlLruCache<RevisionMeta>({
  ttlMs: 60 * 60_000,
  maxSize: 4096,
});

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

/**
 * The revision's meta, or null when it has none (a publish that crashed);
 * `MalformedObjectError` when it is there but unparseable. Parsed metas are
 * cached by (site, id): a revision's meta.json is written once, create-only.
 */
export async function readRevisionMeta(
  store: DeliveryStore,
  site: string,
  id: string,
): Promise<RevisionMeta | null> {
  const cacheKey = `${site}\0${id}`;
  const hit = metas.get(cacheKey);
  if (hit) return hit;
  const key = deliveryKeys.revisionMeta(site, id);
  const object = await store.get(key);
  if (!object) return null;
  let meta: RevisionMeta | null;
  try {
    meta = parseMeta(JSON.parse(object.text));
  } catch {
    meta = null;
  }
  // Present but not a meta.json this Studio wrote (contract §4.3).
  if (!meta) throw new MalformedObjectError(key);
  metas.set(cacheKey, meta);
  return meta;
}

/**
 * Writes a revision: `index.json`, then `meta.json`, each create-only. A
 * folder without `meta.json` is invisible to the Releases list.
 */
export async function writeRevision(
  store: DeliveryStore,
  site: string,
  indexText: string,
  id: string,
  meta: RevisionMeta,
) {
  await store.putText(
    deliveryKeys.revisionIndex(site, id),
    indexText,
    CACHE_REVISION,
    { ifNoneMatch: "*" },
  );
  await store.putJson(
    deliveryKeys.revisionMeta(site, id),
    meta,
    CACHE_REVISION,
    { ifNoneMatch: "*" },
  );
}
