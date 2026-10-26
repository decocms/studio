/**
 * A v8 project's editor draft, kept on the delivery bucket at
 * `sites/<site>/drafts/<slug>.json` as `{ set, delete }`: the changed blocks
 * (whole), and the names the draft deletes. Saving is a whole-object PUT with
 * no git commit, conditional on the ETag the save read (`If-Match`, or
 * `If-None-Match: *` for a new object): Studio runs several API processes,
 * and a save that raced another one reads the draft again and re-applies its
 * change, so neither is lost. Publish commits it to main and, once
 * that release is current, empties it (`{ set: {}, delete: [] }`, same slug,
 * new ETag; a failed release keeps it for "Try again"), so the
 * preview's `?__draft=` pointer keeps its address: the slug lives as long as
 * the (project, branch) does. An editor session creates the empty draft when
 * it opens ({@link DraftStore.ensure}), so a hosted v8 preview always has a
 * pointer to send.
 *
 * The slug is random (holding the URL is the permission to read the draft).
 *
 * Who last changed each name, and when, rides in the object's storage
 * metadata (`draft-editors.ts`), never in the JSON. A save reads the previous
 * object anyway, so it carries the map forward with no extra request.
 */

import type { KVStorage } from "@/storage/kv";
import {
  DRAFT_EDITORS_META,
  type DraftEditors,
  decodeDraftEditors,
  encodeDraftEditors,
  stampDraftEditors,
} from "./draft-editors";
import {
  CACHE_DRAFT,
  type DeliveryStore,
  deliveryKeys,
  newDraftSlug,
  ObjectChangedError,
  type PutCondition,
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
  /** The Studio user saving through this ref, recorded as each changed name's editor. */
  editor?: string | null;
}

export interface LoadedDraft {
  slug: string;
  body: DraftBody;
  etag: string | null;
  /** Who last changed each name the draft holds (the object's metadata). */
  editors: DraftEditors;
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

/** How often a save re-reads and re-applies after another process's save won. */
const DRAFT_WRITE_ATTEMPTS = 8;

/** The condition that makes a write land only on the draft object as read. */
function asRead(etag: string | null): PutCondition {
  return etag ? { ifMatch: etag } : { ifNoneMatch: "*" };
}

/**
 * Runs a read-modify-write until its conditional PUT lands: another API
 * process saved the same draft in between, so it reads it again. Gives up
 * with {@link ObjectChangedError} after {@link DRAFT_WRITE_ATTEMPTS}.
 */
async function untilLanded<T>(attempt: () => Promise<T>): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof ObjectChangedError)) throw error;
      if (n >= DRAFT_WRITE_ATTEMPTS) throw error;
      await new Promise((r) => setTimeout(r, Math.random() * 20 * n));
    }
  }
}

/**
 * Serializes this process's read-modify-writes of one draft (fewer retries);
 * across processes the conditional PUTs keep them from overwriting each other.
 */
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
   * creating the slug on the first write. The PUT lands only on the draft
   * `change` saw: when another process saved first, the draft is read again
   * and `change` runs again on it (so it must only depend on its argument;
   * it may throw to give up).
   */
  update(
    ref: HostedDraftRef,
    change: (body: DraftBody) => DraftBody,
  ): Promise<LoadedDraft>;
  /**
   * Empties the draft: writes `{ set: {}, delete: [] }` to the same slug,
   * with no editors, and returns it (same slug, new ETag). Only while the
   * draft is still the save `expectedEtag` names: a save that landed since
   * (e.g. during a publish) is kept, and returned as it is. `null` when there
   * is no draft.
   */
  empty(
    ref: HostedDraftRef,
    expectedEtag: string | null,
  ): Promise<LoadedDraft | null>;
  /**
   * The draft, created empty when this (project, branch) has none yet (or its
   * object is missing). Never changes an existing draft.
   */
  ensure(ref: HostedDraftRef): Promise<LoadedDraft>;
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
    if (!object) return { slug, body: emptyDraft(), etag: null, editors: {} };
    return {
      slug,
      body: parseDraftBody(JSON.parse(object.text)),
      etag: object.etag,
      editors: decodeDraftEditors(object.metadata?.[DRAFT_EDITORS_META]),
    };
  };

  return {
    load,
    update: (ref, change) =>
      withDraftLock(`${ref.organizationId}\0${slugKey(ref)}`, () =>
        untilLanded(async () => {
          const current = await load(ref);
          const slug = current?.slug ?? newDraftSlug();
          if (!current) {
            await kv.set(ref.organizationId, slugKey(ref), { slug });
          }
          const before = current?.body ?? emptyDraft();
          const body = change(before);
          const editors = stampDraftEditors(
            current?.editors ?? {},
            before,
            body,
            ref.editor,
            Math.floor(Date.now() / 1000),
          );
          const encoded = encodeDraftEditors(editors);
          const { etag } = await store.putJson(
            deliveryKeys.draft(ref.site, slug),
            body,
            CACHE_DRAFT,
            encoded ? { [DRAFT_EDITORS_META]: encoded } : undefined,
            asRead(current?.etag ?? null),
          );
          // What was kept: the oldest may not have fit.
          return { slug, body, etag, editors: decodeDraftEditors(encoded) };
        }),
      ),
    empty: (ref, expectedEtag) =>
      withDraftLock(`${ref.organizationId}\0${slugKey(ref)}`, async () => {
        const current = await load(ref);
        if (!current) return null;
        if (current.etag !== expectedEtag) return current;
        const body = emptyDraft();
        try {
          const { etag } = await store.putJson(
            deliveryKeys.draft(ref.site, current.slug),
            body,
            CACHE_DRAFT,
            undefined,
            asRead(expectedEtag),
          );
          return { slug: current.slug, body, etag, editors: {} };
        } catch (error) {
          // A save landed meanwhile (another process): it is kept.
          if (!(error instanceof ObjectChangedError)) throw error;
          return (await load(ref)) ?? current;
        }
      }),
    ensure: (ref) =>
      withDraftLock(`${ref.organizationId}\0${slugKey(ref)}`, () =>
        untilLanded(async () => {
          const current = await load(ref);
          if (current?.etag) return current;
          const slug = current?.slug ?? newDraftSlug();
          if (!current) {
            await kv.set(ref.organizationId, slugKey(ref), { slug });
          }
          const body = emptyDraft();
          // Never over a draft another process created or saved meanwhile.
          const { etag } = await store.putJson(
            deliveryKeys.draft(ref.site, slug),
            body,
            CACHE_DRAFT,
            undefined,
            asRead(null),
          );
          return { slug, body, etag, editors: {} };
        }),
      ),
  };
}
