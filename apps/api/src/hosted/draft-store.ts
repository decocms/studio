/**
 * A v8 project's editor draft, kept on the delivery bucket at
 * `sites/<site>/drafts/<slug>.json` as `{ set, delete }`: the changed blocks
 * (whole), and the names the draft deletes. Saving is a whole-object PUT with
 * no git commit; the last writer wins. Publish commits it to main and deletes
 * it, so the next edit starts a new slug.
 *
 * The slug is random (holding the URL is the permission to read the draft).
 *
 * Who last changed each draft name, and when (`edits`), lives next to the
 * slug in the org KV, never in the draft object: the object is served to
 * anyone holding its URL, and the site editor only needs it to say who made
 * the other change when two people edit the same values.
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
  /** The Studio user saving through this ref, recorded in `edits`. */
  editor?: string | null;
}

/** The last change to one draft name: a Studio user id and an ISO time. */
export interface DraftEdit {
  by: string;
  at: string;
}

export interface LoadedDraft {
  slug: string;
  body: DraftBody;
  etag: string | null;
  /** By draft name; a name changed by no known user is absent. */
  edits: Record<string, DraftEdit>;
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

function parseEdits(value: unknown): Record<string, DraftEdit> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  // fromEntries: an entry named "__proto__" stays an entry.
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, edit]) => {
      const e = edit as Partial<DraftEdit> | null;
      return typeof e?.by === "string" && typeof e.at === "string"
        ? [[name, { by: e.by, at: e.at }]]
        : [];
    }),
  );
}

/**
 * The edits after a save from `before` to `after`: names whose value (or
 * deletion) changed are stamped with `by` at `at`; untouched names keep
 * theirs; names no longer in the draft (discarded, published) are dropped.
 * Without `by`, a changed name loses its stamp rather than keep a wrong one.
 */
export function stampDraftEdits(
  edits: Record<string, DraftEdit>,
  before: DraftBody,
  after: DraftBody,
  by: string | null | undefined,
  at: string,
): Record<string, DraftEdit> {
  const deletedBefore = new Set(before.delete);
  const deletedAfter = new Set(after.delete);
  const next: Array<[string, DraftEdit]> = [];
  for (const name of new Set([...Object.keys(after.set), ...after.delete])) {
    const changed =
      deletedBefore.has(name) !== deletedAfter.has(name) ||
      Object.hasOwn(before.set, name) !== Object.hasOwn(after.set, name) ||
      JSON.stringify(before.set[name]) !== JSON.stringify(after.set[name]);
    const kept = Object.hasOwn(edits, name) ? edits[name] : undefined;
    if (!changed) {
      if (kept) next.push([name, kept]);
    } else if (by) {
      next.push([name, { by, at }]);
    }
  }
  // fromEntries: an entry named "__proto__" stays an entry.
  return Object.fromEntries(next);
}

function sameEdits(
  a: Record<string, DraftEdit>,
  b: Record<string, DraftEdit>,
): boolean {
  const ka = Object.keys(a);
  return (
    ka.length === Object.keys(b).length &&
    ka.every(
      (k) =>
        Object.hasOwn(b, k) && b[k]!.by === a[k]!.by && b[k]!.at === a[k]!.at,
    )
  );
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
  /**
   * Deletes the draft object and forgets its slug. With `expectedEtag`, it
   * deletes only while the draft is still that save: a save that landed
   * since (e.g. during a publish) keeps the draft for the next publish.
   * Returns whether it deleted.
   */
  remove(ref: HostedDraftRef, expectedEtag?: string | null): Promise<boolean>;
}

export function createDraftStore(deps: {
  kv: KVStorage;
  store: DeliveryStore;
}): DraftStore {
  const { kv, store } = deps;

  const recordOf = async (
    ref: HostedDraftRef,
  ): Promise<{ slug: string; edits: Record<string, DraftEdit> } | null> => {
    const record = await kv.get(ref.organizationId, slugKey(ref));
    return typeof record?.slug === "string"
      ? { slug: record.slug, edits: parseEdits(record.edits) }
      : null;
  };

  const load = async (ref: HostedDraftRef): Promise<LoadedDraft | null> => {
    const record = await recordOf(ref);
    if (!record) return null;
    const { slug, edits } = record;
    const object = await store.get(deliveryKeys.draft(ref.site, slug));
    if (!object) return { slug, body: emptyDraft(), etag: null, edits };
    return {
      slug,
      body: parseDraftBody(JSON.parse(object.text)),
      etag: object.etag,
      edits,
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
        const before = current?.body ?? emptyDraft();
        const body = change(before);
        const { etag } = await store.putJson(
          deliveryKeys.draft(ref.site, slug),
          body,
          CACHE_DRAFT,
        );
        const previous = current?.edits ?? {};
        const edits = stampDraftEdits(
          previous,
          before,
          body,
          ref.editor,
          new Date().toISOString(),
        );
        if (!sameEdits(previous, edits)) {
          // After the object: a failed write here costs only the "changed
          // by" line, never the save.
          await kv
            .set(ref.organizationId, slugKey(ref), { slug, edits })
            .catch((error) =>
              console.warn("hosted draft: edits not recorded", {
                organizationId: ref.organizationId,
                error: error instanceof Error ? error.message : String(error),
              }),
            );
        }
        return { slug, body, etag, edits };
      }),
    remove: (ref, expectedEtag) =>
      withDraftLock(`${ref.organizationId}\0${slugKey(ref)}`, async () => {
        const current = await load(ref);
        if (!current) return false;
        if (expectedEtag !== undefined && current.etag !== expectedEtag) {
          return false;
        }
        await store.delete(deliveryKeys.draft(ref.site, current.slug));
        await kv.delete(ref.organizationId, slugKey(ref));
        return true;
      }),
  };
}
