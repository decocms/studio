/**
 * The hosted CMS's named drafts. A draft is a folder on the delivery bucket
 * at a random slug (holding its URL is the permission to read it), plus one
 * row of the `drafts` table mapping its name, unique within the site, to
 * that slug (contract §1, §2.6–§2.7, §4.1):
 *
 *   drafts/<slug>/index.json     { names }: the block names the draft holds
 *   drafts/<slug>/<file>         one file per name, overwritten by autosave:
 *                                { operation: "set", data, user, via, at }
 *                                { operation: "delete", user, via, at }
 *                                { operation: "published", revision, version }
 *
 * The file is the truth: a listed name whose file is missing, or holds a
 * `published` marker, is not in the draft. A name new to the draft goes into
 * the index first, then its file is written, so nothing written is ever
 * invisible. Every write is conditional on the object as read
 * (`If-None-Match: *` to create, `If-Match` on its ETag otherwise); only the
 * index's read-modify-write is retried here (on 412, up to 3 attempts).
 * Draft folders are never listed: every reader goes index → name → key.
 */

import { createHash } from "node:crypto";
import type { DraftStoragePort } from "@/storage/ports";
import type { CmsDraftRow, CmsVia } from "@/storage/types";
import { MalformedObjectError } from "./cms-release";
import {
  bareEtag,
  CACHE_DRAFT,
  type DeliveryStore,
  DeliveryUnavailableError,
  deliveryKeys,
  draftPointerTarget,
  newDraftSlug,
  ObjectChangedError,
} from "./delivery-store";

export interface DraftEditor {
  userId: string;
  /** Unix seconds. */
  at: number;
}

/** One block's draft file (contract §2.7). */
export type DraftFile =
  | {
      operation: "set";
      data: Record<string, unknown>;
      user: string;
      via: CmsVia;
      at: number;
    }
  | { operation: "delete"; user: string; via: CmsVia; at: number }
  | { operation: "published"; revision: string | null; version: string | null };

/** A draft file as read: null (with `etag` null) when it is missing. */
export interface DraftFileRead {
  file: DraftFile | null;
  etag: string | null;
}

/** The draft index as read: `etag` null when it is missing. */
export interface DraftIndexRead {
  names: string[];
  etag: string | null;
}

/** The draft as one request reads it: the index and every listed file. */
export interface DraftState {
  index: DraftIndexRead;
  files: Map<string, DraftFileRead>;
}

/** Parallel file reads per draft (contract §4.1). */
const READ_CONCURRENCY = 16;
/** The draft index's read-modify-write, attempts in total on 412. */
const INDEX_ATTEMPTS = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const VIAS: ReadonlySet<string> = new Set([
  "studio",
  "cli",
  "token",
  "studio-agent",
]);

function isVia(value: unknown): value is CmsVia {
  return typeof value === "string" && VIAS.has(value);
}

/** Parses a stored draft file; null when it isn't one (§2.7). */
export function parseDraftFile(value: unknown): DraftFile | null {
  if (!isRecord(value)) return null;
  const by = () =>
    typeof value.user === "string" &&
    isVia(value.via) &&
    typeof value.at === "number" &&
    Number.isFinite(value.at);
  switch (value.operation) {
    case "set":
      if (!isRecord(value.data) || !by()) return null;
      return {
        operation: "set",
        // fromEntries: a key named "__proto__" stays a key.
        data: Object.fromEntries(Object.entries(value.data)),
        user: value.user as string,
        via: value.via as CmsVia,
        at: value.at as number,
      };
    case "delete":
      if (!by()) return null;
      return {
        operation: "delete",
        user: value.user as string,
        via: value.via as CmsVia,
        at: value.at as number,
      };
    case "published": {
      const revision = value.revision ?? null;
      const version = value.version ?? null;
      if (revision !== null && typeof revision !== "string") return null;
      if (version !== null && typeof version !== "string") return null;
      return { operation: "published", revision, version };
    }
    default:
      return null;
  }
}

/** Whether a read file puts its name in the draft (`set` or `delete`). */
export function holdsName(
  read: DraftFileRead | undefined,
): read is DraftFileRead & {
  file: Exclude<DraftFile, { operation: "published" }>;
} {
  return !!read?.file && read.file.operation !== "published";
}

/** The editor of a held file. */
export function editorOf(file: DraftFile | null): DraftEditor | null {
  return file && file.operation !== "published"
    ? { userId: file.user, at: file.at }
    : null;
}

/** Deduped, code-unit sorted (§2.6). */
function normalizeNames(names: Iterable<string>): string[] {
  return [...new Set(names)].sort();
}

/** A strong read of the draft index; `{ names: [], etag: null }` when missing. */
export async function readDraftIndex(
  store: DeliveryStore,
  site: string,
  slug: string,
): Promise<DraftIndexRead> {
  const key = deliveryKeys.draftIndex(site, slug);
  const object = await store.get(key);
  if (!object) return { names: [], etag: null };
  let value: unknown;
  try {
    value = JSON.parse(object.text);
  } catch {
    throw new MalformedObjectError(key);
  }
  if (
    !isRecord(value) ||
    !Array.isArray(value.names) ||
    !value.names.every((n) => typeof n === "string")
  ) {
    throw new MalformedObjectError(key);
  }
  return {
    names: normalizeNames(value.names as string[]),
    etag: object.etag,
  };
}

/**
 * The draft index's read-modify-write: `change` maps the names as read to
 * the names wanted; the write is `If-Match` on the read's ETag (create-only
 * when missing), and on 412 the index is read again and `change` reapplied,
 * up to 3 attempts, then `DeliveryUnavailableError`. No write when `change`
 * keeps the names as they are. `first` is a read the caller already made.
 */
export async function updateDraftIndex(
  store: DeliveryStore,
  site: string,
  slug: string,
  change: (names: readonly string[]) => Iterable<string>,
  first?: DraftIndexRead,
): Promise<DraftIndexRead> {
  const key = deliveryKeys.draftIndex(site, slug);
  let read = first ?? (await readDraftIndex(store, site, slug));
  for (let attempt = 1; attempt <= INDEX_ATTEMPTS; attempt++) {
    const names = normalizeNames(change(read.names));
    if (
      read.etag !== null &&
      names.length === read.names.length &&
      names.every((n, i) => n === read.names[i])
    ) {
      return read;
    }
    try {
      const { etag } = await store.putJson(
        key,
        { names },
        CACHE_DRAFT,
        read.etag ? { ifMatch: read.etag } : { ifNoneMatch: "*" },
      );
      return { names, etag };
    } catch (error) {
      if (!(error instanceof ObjectChangedError)) throw error;
    }
    read = await readDraftIndex(store, site, slug);
  }
  throw new DeliveryUnavailableError(
    key,
    new Error(`changed under ${INDEX_ATTEMPTS} attempts`),
  );
}

/** A strong read of one block's draft file. */
export async function readDraftFile(
  store: DeliveryStore,
  site: string,
  slug: string,
  name: string,
): Promise<DraftFileRead> {
  const key = deliveryKeys.draftFile(site, slug, name);
  const object = await store.get(key);
  if (!object) return { file: null, etag: null };
  let file: DraftFile | null;
  try {
    file = parseDraftFile(JSON.parse(object.text));
  } catch {
    file = null;
  }
  if (!file) throw new MalformedObjectError(key);
  return { file, etag: object.etag };
}

/**
 * Writes one block's draft file only while it is as read: `If-Match: etag`,
 * or `If-None-Match: *` when the read found none. A lost race throws
 * `ObjectChangedError`; R2 429/5xx/network `DeliveryUnavailableError`.
 */
export async function writeDraftFile(
  store: DeliveryStore,
  site: string,
  slug: string,
  name: string,
  file: DraftFile,
  etag: string | null,
): Promise<string | null> {
  const { etag: written } = await store.putJson(
    deliveryKeys.draftFile(site, slug, name),
    file,
    CACHE_DRAFT,
    etag ? { ifMatch: etag } : { ifNoneMatch: "*" },
  );
  return written;
}

/** Runs `fn` over `items`, at most `limit` at a time, results in order. */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

/** Reads the files of `names` (parallel, bounded). */
export async function readDraftFiles(
  store: DeliveryStore,
  site: string,
  slug: string,
  names: readonly string[],
): Promise<Map<string, DraftFileRead>> {
  const reads = await mapBounded(names, READ_CONCURRENCY, (name) =>
    readDraftFile(store, site, slug, name),
  );
  return new Map(names.map((name, i) => [name, reads[i]!]));
}

/** The draft index and every file it lists (strong reads). */
export async function readDraftState(
  store: DeliveryStore,
  site: string,
  slug: string,
): Promise<DraftState> {
  const index = await readDraftIndex(store, site, slug);
  return {
    index,
    files: await readDraftFiles(store, site, slug, index.names),
  };
}

/**
 * The opaque revision of "latest ⊕ draft" (contract §2.8): it moves when
 * latest.json names another revision, or the draft index or any listed file
 * that exists changes. 22 base64url characters.
 */
export function draftToken(latestId: string | null, state: DraftState): string {
  const files = [...state.files.entries()]
    .filter(([, read]) => read.file !== null)
    .map(([name, read]) => `${name}:${bareEtag(read.etag) ?? ""}`)
    .sort();
  const text = [
    latestId ?? "none",
    bareEtag(state.index.etag) ?? "",
    ...files,
  ].join("\n");
  return createHash("sha256")
    .update(text, "utf8")
    .digest("base64url")
    .slice(0, 22);
}

/** A draft name: today's branch rule, at most 255 characters (contract §1.5). */
const DRAFT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9/._-]*$/;

export function isValidDraftName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 255 &&
    DRAFT_NAME_RE.test(name)
  );
}

/** A draft as the draft routes answer it (contract §4.1). */
export interface DraftResource {
  name: string;
  slug: string;
  createdBy: string;
  via: CmsVia;
  createdAt: string;
  /** The draft index's bare ETag; null (with `pointer`) when it is missing. */
  etag: string | null;
  /** `?__draft=` pointer: `<host>/<key of the draft index>@<draftToken>`. */
  pointer: string | null;
  /** The site's preview with the pointer; null without a preview server. */
  previewUrl: string | null;
}

export function draftResource(
  row: CmsDraftRow,
  etag: string | null,
  token: string | null,
  previewOrigin: string | null,
): DraftResource {
  const bare = bareEtag(etag);
  const pointer =
    bare && token ? `${draftPointerTarget(row.site, row.slug)}@${token}` : null;
  return {
    name: row.name,
    slug: row.slug,
    createdBy: row.createdBy,
    via: row.via,
    createdAt: row.createdAt,
    etag: bare,
    pointer,
    previewUrl:
      pointer && previewOrigin
        ? `${previewOrigin}/?__draft=${encodeURIComponent(pointer)}`
        : null,
  };
}

export interface CmsDrafts {
  list(site: string): Promise<CmsDraftRow[]>;
  /** The row alone (no object read), or null. */
  row(site: string, name: string): Promise<CmsDraftRow | null>;
  /** The row, the draft index and every listed file, or null without a row. */
  resolve(
    site: string,
    name: string,
  ): Promise<{ row: CmsDraftRow; state: DraftState } | null>;
  /**
   * Inserts the row when absent (the race loser uses the winner's slug),
   * then makes sure its index exists (create-only: a 412 means it does).
   */
  ensure(
    site: string,
    name: string,
    by: { userId: string; via: CmsVia },
  ): Promise<{ row: CmsDraftRow; created: boolean; state: DraftState }>;
  /**
   * Deletes every listed file, then the index, then the row; false when
   * there was no row. A failed delete keeps the row, so it can be retried.
   */
  discard(site: string, name: string): Promise<boolean>;
}

export function createCmsDrafts(deps: {
  table: DraftStoragePort;
  store: DeliveryStore;
}): CmsDrafts {
  const { table, store } = deps;
  return {
    list: (site) => table.list(site),
    row: (site, name) => table.get(site, name),
    async resolve(site, name) {
      const row = await table.get(site, name);
      if (!row) return null;
      return { row, state: await readDraftState(store, site, row.slug) };
    },
    async ensure(site, name, by) {
      const { row, created } = await table.insertIfAbsent({
        site,
        name,
        slug: newDraftSlug(),
        createdBy: by.userId,
        via: by.via,
      });
      const state = await readDraftState(store, site, row.slug);
      if (state.index.etag) return { row, created, state };
      try {
        const { etag } = await store.putJson(
          deliveryKeys.draftIndex(site, row.slug),
          { names: [] },
          CACHE_DRAFT,
          { ifNoneMatch: "*" },
        );
        return {
          row,
          created,
          state: { index: { names: [], etag }, files: new Map() },
        };
      } catch (error) {
        // Created by another call meanwhile: read what is there.
        if (!(error instanceof ObjectChangedError)) throw error;
        return {
          row,
          created,
          state: await readDraftState(store, site, row.slug),
        };
      }
    },
    async discard(site, name) {
      const row = await table.get(site, name);
      if (!row) return false;
      const index = await readDraftIndex(store, site, row.slug);
      for (const listed of index.names) {
        await store.delete(deliveryKeys.draftFile(site, row.slug, listed));
      }
      await store.delete(deliveryKeys.draftIndex(site, row.slug));
      await table.delete(site, name);
      return true;
    },
  };
}
