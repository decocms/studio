/**
 * In-memory stand-ins for the hosted CMS tests: the `drafts` table and the
 * record bucket. The delivery bucket is `memoryDeliveryStore`.
 */

import type { DraftStoragePort } from "@/storage/ports";
import type { CmsDraftRow } from "@/storage/types";
import { type BlockIndex, indexEntry, META_VERSION } from "./block-meta";
import {
  readLatest,
  type RevisionMeta,
  serializeIndex,
  writeBlockObject,
  writeLatest,
  writeRevision,
} from "./cms-release";
import {
  type DraftFile,
  readDraftFile,
  updateDraftIndex,
  writeDraftFile,
} from "./cms-drafts";
import type { DeliveryStore } from "./delivery-store";
import type { RecordStore } from "./record-store";

export function memoryDraftTable(): DraftStoragePort & {
  rows: Map<string, CmsDraftRow>;
} {
  const rows = new Map<string, CmsDraftRow>();
  let tick = 0;
  const key = (site: string, name: string) => `${site}\0${name}`;
  return {
    rows,
    async list(site) {
      return [...rows.values()]
        .filter((r) => r.site === site)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    },
    async get(site, name) {
      return rows.get(key(site, name)) ?? null;
    },
    async insertIfAbsent(row) {
      const existing = rows.get(key(row.site, row.name));
      if (existing) return { row: existing, created: false };
      const created: CmsDraftRow = {
        ...row,
        createdAt: new Date(Date.UTC(2026, 10, 4, 10, 0, tick++)).toISOString(),
      };
      rows.set(key(row.site, row.name), created);
      return { row: created, created: true };
    },
    async delete(site, name) {
      return rows.delete(key(site, name));
    },
  };
}

export function memoryRecordStore(): RecordStore & {
  objects: Map<string, { text: string; etag: string }>;
  reads: Array<{ site: string; ifNoneMatch: string | null }>;
} {
  const objects = new Map<string, { text: string; etag: string }>();
  const reads: Array<{ site: string; ifNoneMatch: string | null }> = [];
  let n = 0;
  return {
    objects,
    reads,
    async putSchema(site, text) {
      const etag = `"schema${++n}"`;
      objects.set(site, { text, etag });
      return { etag };
    },
    async getSchema(site, ifNoneMatch) {
      reads.push({ site, ifNoneMatch: ifNoneMatch ?? null });
      const o = objects.get(site);
      if (!o) return null;
      if (ifNoneMatch && ifNoneMatch === o.etag) {
        return { notModified: true, etag: o.etag };
      }
      return { notModified: false, text: o.text, etag: o.etag };
    },
  };
}

/**
 * Writes a live revision of `blocks` for tests, as publish would: each
 * body at `blocks/<hash>.json`, the revision's index and meta, then
 * latest.json (the next `sequence`). Returns the index's entries.
 * `legacy`: as a Studio before `noIndex` wrote it (no `metaVersion`, no
 * `noIndex`).
 */
export async function seedRelease(
  store: DeliveryStore,
  site: string,
  id: string,
  blocks: Record<string, unknown>,
  meta: Partial<RevisionMeta> = {},
  options: { legacy?: boolean } = {},
): Promise<BlockIndex> {
  const live = await readLatest(store, site);
  const names = Object.keys(blocks);
  const bodyOf = (name: string) =>
    Object.hasOwn(blocks, name) ? blocks[name] : undefined;
  const entries: BlockIndex = Object.fromEntries(
    await Promise.all(
      Object.entries(blocks).map(async ([name, body]) => {
        const entry = await indexEntry(
          name,
          body,
          names,
          options.legacy ? undefined : bodyOf,
        );
        if (options.legacy) delete entry.meta?.noIndex;
        return [name, entry] as const;
      }),
    ),
  );
  for (const [name, body] of Object.entries(blocks)) {
    await writeBlockObject(
      store,
      site,
      entries[name]!.version,
      JSON.stringify(body),
    );
  }
  const index = {
    revision: id,
    sequence: (live?.latest.sequence ?? 0) + 1,
    ...(options.legacy ? {} : { metaVersion: META_VERSION }),
    blocks: entries,
  };
  await writeRevision(store, site, serializeIndex(index), id, {
    previous: live?.latest.revision ?? null,
    author: "usr_seed",
    via: "studio",
    message: "",
    publishedAt: "2026-11-03T12:00:00.000Z",
    ...meta,
  });
  await writeLatest(
    store,
    site,
    { ...index, previewHosts: [] },
    live?.etag ?? null,
  );
  return entries;
}

/** Writes a draft file the way a save would: the name into the index first. */
export async function seedDraftFile(
  store: DeliveryStore,
  site: string,
  slug: string,
  name: string,
  file: DraftFile,
): Promise<string | null> {
  await updateDraftIndex(store, site, slug, (names) => [...names, name]);
  const current = await readDraftFile(store, site, slug, name);
  return writeDraftFile(store, site, slug, name, file, current.etag);
}

/** A `set` draft file by `user` at Unix second `at`. */
export function setFile(
  data: Record<string, unknown>,
  user = "usr_ana",
  at = 1793800000,
): DraftFile {
  return { operation: "set", data, user, via: "studio", at };
}

/** A `delete` draft file by `user` at Unix second `at`. */
export function deleteFile(user = "usr_ana", at = 1793800000): DraftFile {
  return { operation: "delete", user, via: "studio", at };
}
