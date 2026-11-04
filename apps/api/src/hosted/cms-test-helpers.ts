/**
 * In-memory stand-ins for the hosted CMS tests: the `drafts` table and the
 * record bucket. The delivery bucket is `memoryDeliveryStore`.
 */

import type { DraftStoragePort } from "@/storage/ports";
import type { CmsDraftRow } from "@/storage/types";
import {
  readLatestPointer,
  type RevisionMeta,
  serializeRevisionData,
  writeLatestPointer,
  writeRevision,
} from "./cms-release";
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

/** Writes a live revision of `blocks` (data, meta, latest.json) for tests. */
export async function seedRelease(
  store: DeliveryStore,
  site: string,
  id: string,
  blocks: Record<string, unknown>,
  meta: Partial<RevisionMeta> = {},
) {
  const latest = await readLatestPointer(store, site);
  await writeRevision(store, site, id, serializeRevisionData(blocks), {
    previous: latest?.pointer.revision ?? null,
    author: "usr_seed",
    via: "studio",
    message: "",
    publishedAt: "2026-11-03T12:00:00.000Z",
    ...meta,
  });
  await writeLatestPointer(
    store,
    site,
    { revision: id, previewHosts: [] },
    latest?.etag ?? null,
  );
}
