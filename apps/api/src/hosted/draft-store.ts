/**
 * A v8 project's editor draft, kept on the delivery bucket at
 * `sites/<site>/drafts/<slug>.json` as `{ set, delete }`: the changed blocks
 * (whole), and the names the draft deletes. Saving is a whole-object PUT with
 * no git commit; the last writer wins. Publish commits it to main and deletes
 * it, so the next edit starts a new slug.
 *
 * The slug is random (holding the URL is the permission to read the draft).
 */

import type { KVStorage } from "@/storage/kv";
import {
  CACHE_DRAFT,
  type DeliveryStore,
  deliveryKeys,
  newDraftSlug,
} from "./delivery-store";

export interface DraftBody {
  set: Record<string, unknown>;
  delete: string[];
}

export interface HostedDraftRef {
  organizationId: string;
  virtualMcpId: string;
  branch: string;
  site: string;
}

export interface LoadedDraft {
  slug: string;
  body: DraftBody;
  etag: string | null;
}

function emptyDraft(): DraftBody {
  return { set: {}, delete: [] };
}

export function isEmptyDraft(body: DraftBody): boolean {
  return Object.keys(body.set).length === 0 && body.delete.length === 0;
}

/** Parses a stored draft; throws on anything but `{ set, delete }`. */
function parseDraftBody(value: unknown): DraftBody {
  const v = value as { set?: unknown; delete?: unknown } | null;
  if (
    typeof v !== "object" ||
    v === null ||
    typeof v.set !== "object" ||
    v.set === null ||
    Array.isArray(v.set) ||
    !Array.isArray(v.delete) ||
    !v.delete.every((name) => typeof name === "string")
  ) {
    throw new Error("stored draft isn't { set, delete }");
  }
  // fromEntries: an entry named "__proto__" stays an entry.
  return {
    set: Object.fromEntries(Object.entries(v.set as Record<string, unknown>)),
    delete: [...(v.delete as string[])],
  };
}

// OPEN: O-S1 — the draft slug lives in the org KV under (project, branch),
// where the v8 draft branch name used to be implied; no migration needed.
function slugKey(ref: HostedDraftRef): string {
  return `v8-draft:${ref.virtualMcpId}:${ref.branch}`;
}

const locks = new Map<string, Promise<unknown>>();

/** Serializes this process's read-modify-writes of one draft. */
function withDraftLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(fn);
  const settled = next.catch(() => {});
  locks.set(key, settled);
  void settled.finally(() => {
    if (locks.get(key) === settled) locks.delete(key);
  });
  return next;
}

export interface DraftStore {
  /** The draft, or null when this (project, branch) has none. */
  load(ref: HostedDraftRef): Promise<LoadedDraft | null>;
  /**
   * Applies `change` to the current draft (empty when none) and PUTs it,
   * creating the slug on the first write.
   */
  update(
    ref: HostedDraftRef,
    change: (body: DraftBody) => DraftBody,
  ): Promise<LoadedDraft>;
  /** Deletes the draft object and forgets its slug. */
  remove(ref: HostedDraftRef): Promise<void>;
}

export function createDraftStore(deps: {
  kv: KVStorage;
  store: DeliveryStore;
}): DraftStore {
  const { kv, store } = deps;

  const slugOf = async (ref: HostedDraftRef): Promise<string | null> => {
    const record = await kv.get(ref.organizationId, slugKey(ref));
    return typeof record?.slug === "string" ? record.slug : null;
  };

  const load = async (ref: HostedDraftRef): Promise<LoadedDraft | null> => {
    const slug = await slugOf(ref);
    if (!slug) return null;
    const object = await store.get(deliveryKeys.draft(ref.site, slug));
    if (!object) return { slug, body: emptyDraft(), etag: null };
    return {
      slug,
      body: parseDraftBody(JSON.parse(object.text)),
      etag: object.etag,
    };
  };

  return {
    load,
    update: (ref, change) =>
      withDraftLock(`${ref.organizationId}\0${slugKey(ref)}`, async () => {
        const current = await load(ref);
        const slug = current?.slug ?? newDraftSlug();
        if (!current) {
          await kv.set(ref.organizationId, slugKey(ref), { slug });
        }
        const body = change(current?.body ?? emptyDraft());
        const { etag } = await store.putJson(
          deliveryKeys.draft(ref.site, slug),
          body,
          CACHE_DRAFT,
        );
        return { slug, body, etag };
      }),
    remove: (ref) =>
      withDraftLock(`${ref.organizationId}\0${slugKey(ref)}`, async () => {
        const slug = await slugOf(ref);
        if (!slug) return;
        await store.delete(deliveryKeys.draft(ref.site, slug));
        await kv.delete(ref.organizationId, slugKey(ref));
      }),
  };
}
