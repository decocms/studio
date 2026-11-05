/**
 * Studio's hosted CMS (`backend.source === "github"`) reads only the index
 * plus the blocks a view opens (design "Studio reads only the index plus the
 * blocks a view opens"; contract §5):
 *
 * - `cms.index` (polled with the schema and the changes) answers every
 *   name's version and small metadata (`type`, `path`, `refs`) and, for the
 *   names the draft holds, their draft version and editor. It is kept in
 *   `KEYS.contentIndex`; the draft versions are what a save's `ifMatch`
 *   carries.
 * - `KEYS.decofile` holds only the bodies loaded so far. `ensureHostedBlocks`
 *   loads the ones a view opens, through `cms.blocks` (50 names a call).
 * - List views see {@link listingOf}: every name of the index, an unloaded
 *   one as a stub carrying only its type and path (`INDEX_STUB`). A stub is
 *   never saved ({@link stubNames}).
 */

import type { QueryClient } from "@tanstack/react-query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  type BatchCall,
  type BatchOutcome,
  ContentProtocolError,
  ErrorCode,
} from "@decocms/blocks/protocol";
import { DRAFT_TOMBSTONE_VERSION } from "@decocms/shared/blocks-major";
import { KEYS } from "@/lib/query-keys";
import { keepContentBookkeeping } from "./content-bookkeeping";

/** One name of the overlaid index (latest ⊕ draft), as `cms.index` answers it. */
export interface HostedIndexEntry {
  version: string;
  meta?: { type?: string; path?: string; refs?: string[] };
}

/** A name the draft holds. */
export interface HostedDraftEntry {
  operation: "set" | "delete";
  version: string;
  editor: { userId: string; at: number } | null;
}

/** `cms.index`'s answer, as `KEYS.contentIndex` keeps it. */
export interface ContentIndex {
  revision: string;
  resolvedRef: string | null;
  sequence: number;
  entries: Record<string, HostedIndexEntry>;
  draft: Record<string, HostedDraftEntry>;
}

export type CmsIndexResult =
  | { notModified: true; revision: string }
  | ({ notModified: false } & ContentIndex);

export interface CmsBlocksResult {
  blocks: Record<string, Record<string, unknown>>;
  versions: Record<string, string>;
  missing: string[];
}

/** One call of a hosted batch: a protocol method or a Studio one. */
export type HostedCall =
  | BatchCall
  | { method: "cms.index"; params?: { ifNoneMatch?: string } }
  | { method: "cms.blocks"; params: { names: string[] } };

/** The hosted draft's endpoint, for calls the protocol client doesn't know. */
export interface HostedRpc {
  batch(calls: HostedCall[]): Promise<BatchOutcome[]>;
}

/** `cms.blocks`'s limit of names per call. */
const BLOCKS_PER_CALL = 50;
/** The protocol's limit of calls per batch. */
const CALLS_PER_BATCH = 10;

/** A JSON-RPC client of the hosted draft's endpoint (`/api/cms/:site/drafts/:name/rpc`). */
export function createHostedRpc(
  endpoint: string,
  doFetch: (request: Request) => Promise<Response> = (request) =>
    fetch(request),
): HostedRpc {
  let nextId = 1;
  return {
    async batch(calls) {
      const ids = calls.map(() => nextId++);
      const response = await doFetch(
        new Request(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify(
            calls.map((c, i) => ({
              jsonrpc: "2.0",
              id: ids[i],
              method: c.method,
              params: c.params ?? {},
            })),
          ),
        }),
      );
      if (!response.ok) {
        throw new ContentProtocolError(
          ErrorCode.Unavailable,
          `the hosted CMS answered ${response.status}`,
        );
      }
      const answers = (await response.json()) as Array<{
        id: number;
        result?: unknown;
        error?: { code: number; message: string; data?: unknown };
      }>;
      const byId = new Map(
        (Array.isArray(answers) ? answers : []).map((a) => [a.id, a]),
      );
      return ids.map((id): BatchOutcome => {
        const answer = byId.get(id);
        if (!answer) {
          return {
            ok: false,
            error: new ContentProtocolError(
              ErrorCode.InternalError,
              "no response for this call",
            ),
          };
        }
        return answer.error
          ? { ok: false, error: ContentProtocolError.from(answer.error) }
          : { ok: true, result: answer.result };
      });
    },
  };
}

/** The key that marks an index stub: a block whose body isn't loaded. */
const INDEX_STUB = "__indexStub";

/** Whether `value` is an index stub (or a copy of one). */
export function isIndexStub(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, INDEX_STUB)
  );
}

/** The names of `set` whose value is an index stub: never written. */
export function stubNames(set: Record<string, unknown> | undefined): string[] {
  return Object.entries(set ?? {})
    .filter(([, value]) => isIndexStub(value))
    .map(([name]) => name);
}

/**
 * Every name of the index, for list views: a loaded body as it is, any
 * other as a stub with its raw type and path. Index order.
 */
export function listingOf(
  index: ContentIndex | undefined,
  loaded: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!index) return loaded ?? {};
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(index.entries)) {
    if (loaded && Object.hasOwn(loaded, name)) {
      out[name] = loaded[name];
      continue;
    }
    out[name] = {
      [INDEX_STUB]: true,
      ...(entry.meta?.type ? { __resolveType: entry.meta.type } : {}),
      ...(entry.meta?.path !== undefined ? { path: entry.meta.path } : {}),
    };
  }
  // A block saved here and not yet in a polled index.
  for (const [name, body] of Object.entries(loaded ?? {})) {
    if (!Object.hasOwn(out, name)) out[name] = body;
  }
  return out;
}

/** The names `name`'s body references directly, as the index says. */
function refsOf(index: ContentIndex | undefined, name: string): string[] {
  return index?.entries[name]?.meta?.refs ?? [];
}

/** `name`'s version in the draft alone: what a hosted `ifMatch` carries. */
export function draftVersionIn(
  index: ContentIndex,
  name: string,
): string | null {
  return Object.hasOwn(index.draft, name)
    ? (index.draft[name]?.version ?? null)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function collectTypes(value: unknown, out: Set<string>) {
  if (Array.isArray(value)) {
    for (const item of value) collectTypes(item, out);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, inner] of Object.entries(value)) {
    if (key === "__resolveType" && typeof inner === "string") out.add(inner);
    else collectTypes(inner, out);
  }
}

/**
 * The index meta of a body this editor just saved (the server's
 * `blockMeta`), so a list shows a new page's path before the next poll.
 */
function indexMetaOf(
  body: unknown,
  names: ReadonlySet<string>,
): HostedIndexEntry["meta"] {
  if (!isRecord(body)) return undefined;
  const meta: NonNullable<HostedIndexEntry["meta"]> = {};
  if (typeof body.__resolveType === "string") meta.type = body.__resolveType;
  if (typeof body.path === "string") meta.path = body.path;
  const found = new Set<string>();
  collectTypes(body, found);
  const refs = [...found].filter((n) => names.has(n)).sort();
  if (refs.length > 0) meta.refs = refs;
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/**
 * A save's answer, kept in the index: each set name's new draft version
 * and entry (meta from its body), each deleted name gone from the entries
 * with its tombstone in the draft.
 */
export function adoptSaveIntoIndex(
  queryClient: QueryClient,
  cacheKey: string,
  versions: Record<string, string | null>,
  bodies: Record<string, unknown>,
) {
  keepContentBookkeeping(queryClient);
  queryClient.setQueryData<ContentIndex>(
    KEYS.contentIndex(cacheKey),
    (index) => {
      if (!index) return index;
      const entries = { ...index.entries };
      const draft = { ...index.draft };
      const names = new Set([...Object.keys(entries), ...Object.keys(bodies)]);
      for (const [name, version] of Object.entries(versions)) {
        const editor = draft[name]?.editor ?? null;
        if (version === null || version === DRAFT_TOMBSTONE_VERSION) {
          delete entries[name];
          draft[name] = {
            operation: "delete",
            version: DRAFT_TOMBSTONE_VERSION,
            editor,
          };
          continue;
        }
        const meta = indexMetaOf(bodies[name], names);
        entries[name] = { version, ...(meta ? { meta } : {}) };
        draft[name] = { operation: "set", version, editor };
      }
      return { ...index, entries, draft };
    },
  );
}

/** The draft's copy of one block, as a refused save carried it, kept in the index. */
export function adoptDraftCopyIntoIndex(
  queryClient: QueryClient,
  cacheKey: string,
  name: string,
  stored: { block: unknown; version: string } | null,
) {
  queryClient.setQueryData<ContentIndex>(
    KEYS.contentIndex(cacheKey),
    (index) => {
      if (!index) return index;
      const draft = { ...index.draft };
      if (stored === null) delete draft[name];
      else {
        draft[name] = {
          operation: stored.block === null ? "delete" : "set",
          version: stored.version,
          editor: draft[name]?.editor ?? null,
        };
      }
      return { ...index, draft };
    },
  );
}

const loading = new Map<string, Promise<void>>();

/**
 * Loads the bodies of `names` that the editor doesn't hold at the index's
 * version, through `cms.blocks` (50 names a call, 10 calls a request), into
 * `KEYS.decofile` with their versions in `KEYS.contentVersions`. A name
 * already loading joins that load; a name the index doesn't have is skipped
 * (it can't be read). A block being saved keeps the editor's copy.
 */
export async function ensureHostedBlocks(
  queryClient: QueryClient,
  rpc: HostedRpc,
  cacheKey: string,
  names: readonly string[],
  saving: ReadonlySet<string> = new Set(),
): Promise<void> {
  const index = queryClient.getQueryData<ContentIndex>(
    KEYS.contentIndex(cacheKey),
  );
  if (!index) return;
  const loaded =
    queryClient.getQueryData<Record<string, unknown>>(
      KEYS.decofile(cacheKey),
    ) ?? {};
  const versions =
    queryClient.getQueryData<Record<string, string>>(
      KEYS.contentVersions(cacheKey),
    ) ?? {};
  const waits: Promise<void>[] = [];
  const wanted: string[] = [];
  for (const name of new Set(names)) {
    const entry = index.entries[name];
    if (!entry || saving.has(name)) continue;
    if (Object.hasOwn(loaded, name) && versions[name] === entry.version)
      continue;
    const running = loading.get(`${cacheKey}\0${name}`);
    if (running) waits.push(running);
    else wanted.push(name);
  }
  if (wanted.length > 0) {
    const load = loadBlocks(queryClient, rpc, cacheKey, wanted);
    for (const name of wanted) {
      const key = `${cacheKey}\0${name}`;
      loading.set(key, load);
      void load
        .catch(() => {})
        .finally(() => {
          if (loading.get(key) === load) loading.delete(key);
        });
    }
    waits.push(load);
  }
  await Promise.all(waits);
}

async function loadBlocks(
  queryClient: QueryClient,
  rpc: HostedRpc,
  cacheKey: string,
  names: string[],
): Promise<void> {
  const chunks: string[][] = [];
  for (let i = 0; i < names.length; i += BLOCKS_PER_CALL) {
    chunks.push(names.slice(i, i + BLOCKS_PER_CALL));
  }
  for (let i = 0; i < chunks.length; i += CALLS_PER_BATCH) {
    const outcomes = await rpc.batch(
      chunks
        .slice(i, i + CALLS_PER_BATCH)
        .map((chunk) => ({ method: "cms.blocks", params: { names: chunk } })),
    );
    for (const outcome of outcomes) {
      if (!outcome.ok) throw outcome.error;
      const result = outcome.result as CmsBlocksResult;
      keepContentBookkeeping(queryClient);
      queryClient.setQueryData<Record<string, unknown>>(
        KEYS.decofile(cacheKey),
        (current) => {
          const next = { ...current };
          for (const [name, body] of Object.entries(result.blocks)) {
            next[name] = body;
          }
          for (const name of result.missing) delete next[name];
          return next;
        },
      );
      queryClient.setQueryData<Record<string, string>>(
        KEYS.contentVersions(cacheKey),
        (current) => {
          const next = { ...current };
          for (const [name, version] of Object.entries(result.versions)) {
            next[name] = version;
          }
          for (const name of result.missing) delete next[name];
          return next;
        },
      );
    }
  }
}

/** The project's index as the last `cms.index` answered it (watched, never fetched). */
export function useContentIndex(cacheKey: string): ContentIndex | undefined {
  const { data } = useQuery<ContentIndex>({
    queryKey: KEYS.contentIndex(cacheKey),
    enabled: false,
    queryFn: async () => {
      throw new Error("the content index is set by the poll");
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
  return data;
}

/**
 * Loads `names` (and the names their bodies reference directly, when
 * `withRefs`) once the index is read, and again when the index moves their
 * versions. True once every one the index has is loaded.
 */
export function useEnsureHostedBlocks(
  rpc: HostedRpc | null | undefined,
  cacheKey: string,
  names: readonly string[],
  options?: { withRefs?: boolean },
): boolean {
  const queryClient = useQueryClient();
  const index = useContentIndex(cacheKey);
  const { data: loaded } = useQuery<Record<string, unknown>>({
    queryKey: KEYS.decofile(cacheKey),
    enabled: false,
    queryFn: async () => ({}),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const withRefs = options?.withRefs ?? false;
  const wantedSet = new Set(names);
  if (withRefs) {
    for (const name of names) {
      for (const ref of refsOf(index, name)) wantedSet.add(ref);
    }
  }
  const wanted = [...wantedSet].filter((name) => !!index?.entries[name]).sort();
  const pending = wanted.some(
    (name) => !loaded || !Object.hasOwn(loaded, name),
  );
  const key = wanted
    .map((name) => `${name}@${index?.entries[name]?.version ?? ""}`)
    .join("\n");
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- loads what the view opens when the index names it
  useEffect(() => {
    if (!rpc || !key) return;
    // `key` carries the names wanted and their versions.
    const names = key
      .split("\n")
      .map((line) => line.slice(0, line.lastIndexOf("@")));
    void ensureHostedBlocks(queryClient, rpc, cacheKey, names).catch(() => {});
  }, [rpc, queryClient, cacheKey, key]);
  return !rpc || !pending;
}
