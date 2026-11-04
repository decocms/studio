/**
 * The hosted CMS's named drafts. A draft is one public object on the
 * delivery bucket, `sites/<site>/drafts/<slug>.json` = `{ set, delete,
 * editors }` (contract §2.4), at a random slug (holding its URL is the
 * permission to read it), and one row of the `drafts` table mapping its
 * name, unique within the site, to that slug.
 *
 * Who last changed each name, and when, is in the JSON (`editors`: a Studio
 * user id and Unix seconds), written atomically with the change. Every
 * write is conditional on the object as read: `If-None-Match: *` to create,
 * `If-Match` on its ETag otherwise. Nothing here retries: a lost race is
 * the caller's answer (a save answers Unavailable; publish keeps the draft).
 */

import type { DraftStoragePort } from "@/storage/ports";
import type { CmsDraftRow, CmsVia } from "@/storage/types";
import {
  bareEtag,
  CACHE_DRAFT,
  type DeliveryStore,
  deliveryKeys,
  draftPointerTarget,
  newDraftSlug,
} from "./delivery-store";

export interface DraftEditor {
  userId: string;
  /** Unix seconds. */
  at: number;
}

export interface CmsDraftBody {
  set: Record<string, unknown>;
  delete: string[];
  editors: Record<string, DraftEditor>;
}

/** A strong read of the draft object; `etag` null when it is missing. */
export interface DraftRead {
  body: CmsDraftBody;
  etag: string | null;
}

export function emptyDraftBody(): CmsDraftBody {
  return { set: {}, delete: [], editors: {} };
}

export function isEmptyDraftBody(body: CmsDraftBody): boolean {
  return Object.keys(body.set).length === 0 && body.delete.length === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parses a stored draft; throws on anything but `{ set, delete }`. A
 * missing `editors` is `{}`, and a malformed editor entry is left out.
 */
export function parseDraftBody(value: unknown): CmsDraftBody {
  if (
    !isRecord(value) ||
    !isRecord(value.set) ||
    !Array.isArray(value.delete) ||
    !value.delete.every((name) => typeof name === "string")
  ) {
    throw new Error("stored draft isn't { set, delete, editors }");
  }
  const editors: Array<[string, DraftEditor]> = [];
  if (isRecord(value.editors)) {
    for (const [name, editor] of Object.entries(value.editors)) {
      if (
        isRecord(editor) &&
        typeof editor.userId === "string" &&
        typeof editor.at === "number" &&
        Number.isFinite(editor.at)
      ) {
        editors.push([name, { userId: editor.userId, at: editor.at }]);
      }
    }
  }
  // fromEntries: an entry named "__proto__" stays an entry.
  return {
    set: Object.fromEntries(Object.entries(value.set)),
    delete: [...(value.delete as string[])],
    editors: Object.fromEntries(editors),
  };
}

/**
 * The editors after a write from `before` to `after` (bodies without
 * editors): a name whose value or deletion changed is stamped with `userId`
 * at `at`; an untouched name keeps its entry; a name no longer in the draft
 * is dropped. One entry per name the draft sets or deletes, no others.
 */
export function stampEditors(
  before: CmsDraftBody,
  after: Pick<CmsDraftBody, "set" | "delete">,
  userId: string,
  at: number,
): Record<string, DraftEditor> {
  const deletedBefore = new Set(before.delete);
  const deletedAfter = new Set(after.delete);
  const next: Array<[string, DraftEditor]> = [];
  for (const name of new Set([...Object.keys(after.set), ...after.delete])) {
    const changed =
      deletedBefore.has(name) !== deletedAfter.has(name) ||
      Object.hasOwn(before.set, name) !== Object.hasOwn(after.set, name) ||
      JSON.stringify(before.set[name]) !== JSON.stringify(after.set[name]);
    const kept = Object.hasOwn(before.editors, name)
      ? before.editors[name]
      : undefined;
    if (changed) next.push([name, { userId, at }]);
    else if (kept) next.push([name, kept]);
  }
  return Object.fromEntries(next);
}

/** A strong read of the draft object (through the R2 API). */
export async function readDraftObject(
  store: DeliveryStore,
  site: string,
  slug: string,
): Promise<DraftRead> {
  const object = await store.get(deliveryKeys.draft(site, slug));
  if (!object) return { body: emptyDraftBody(), etag: null };
  return { body: parseDraftBody(JSON.parse(object.text)), etag: object.etag };
}

/**
 * Writes the draft only while it is as read: `If-Match: etag`, or
 * `If-None-Match: *` when the read found no object. A lost race throws
 * `ObjectChangedError`; R2 429/5xx/network `DeliveryUnavailableError`.
 */
export async function writeDraftObject(
  store: DeliveryStore,
  site: string,
  slug: string,
  body: CmsDraftBody,
  etag: string | null,
): Promise<string | null> {
  const { etag: written } = await store.putJson(
    deliveryKeys.draft(site, slug),
    { set: body.set, delete: body.delete, editors: body.editors },
    CACHE_DRAFT,
    etag ? { ifMatch: etag } : { ifNoneMatch: "*" },
  );
  return written;
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

/** A draft as the draft routes answer it (contract §4.5). */
export interface DraftResource {
  name: string;
  slug: string;
  createdBy: string;
  via: CmsVia;
  createdAt: string;
  /** The object's bare ETag; null (with `pointer`) when the object is missing. */
  etag: string | null;
  /** `?__draft=` pointer: `<host>/<key>@<etag>`. */
  pointer: string | null;
  /** The site's preview with the pointer; null without a preview server. */
  previewUrl: string | null;
}

export function draftResource(
  row: CmsDraftRow,
  etag: string | null,
  previewOrigin: string | null,
): DraftResource {
  const bare = bareEtag(etag);
  const pointer = bare
    ? `${draftPointerTarget(row.site, row.slug)}@${bare}`
    : null;
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
  /** The row and a strong read of its object, or null when there's no row. */
  resolve(
    site: string,
    name: string,
  ): Promise<{ row: CmsDraftRow; read: DraftRead } | null>;
  /**
   * Inserts the row when absent (the race loser uses the winner's slug),
   * then makes sure its object exists (create-only: a 412 means it does).
   */
  ensure(
    site: string,
    name: string,
    by: { userId: string; via: CmsVia },
  ): Promise<{ row: CmsDraftRow; created: boolean; etag: string | null }>;
  /** Deletes the row, then the object; false when there was no row. */
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
      return { row, read: await readDraftObject(store, site, row.slug) };
    },
    async ensure(site, name, by) {
      const { row, created } = await table.insertIfAbsent({
        site,
        name,
        slug: newDraftSlug(),
        createdBy: by.userId,
        via: by.via,
      });
      const current = await store.get(deliveryKeys.draft(site, row.slug));
      if (current) return { row, created, etag: current.etag };
      try {
        const etag = await writeDraftObject(
          store,
          site,
          row.slug,
          emptyDraftBody(),
          null,
        );
        return { row, created, etag };
      } catch (error) {
        // Created by another call meanwhile: read what is there.
        const again = await store.get(deliveryKeys.draft(site, row.slug));
        if (again) return { row, created, etag: again.etag };
        throw error;
      }
    },
    async discard(site, name) {
      const row = await table.get(site, name);
      if (!row) return false;
      await table.delete(site, name);
      await store.delete(deliveryKeys.draft(site, row.slug));
      return true;
    },
  };
}
