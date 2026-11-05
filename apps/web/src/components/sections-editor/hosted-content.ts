/**
 * Studio's hosted CMS (`backend.source === "github"`) reads only the index
 * plus the blocks a view opens (design "Studio reads only the index plus the
 * blocks a view opens"; contract §5):
 *
 * - `cms.index` (polled with the schema and the changes) answers every
 *   name's version and small metadata (`type`, `path`, `refs`, `rules`)
 *   and, for the names the draft holds, their draft version and editor. It
 *   is kept in `KEYS.contentIndex`; the draft versions are what a save's
 *   `ifMatch` carries.
 * - `KEYS.decofile` holds only the bodies loaded so far. `ensureHostedBlocks`
 *   loads the ones a view opens, through `cms.blocks` (50 names a call).
 * - List views see {@link listingOf}: every name of the index, an unloaded
 *   one as a stub carrying only its type, path, direct references and the
 *   tests and campaigns it uses (`INDEX_STUB`, {@link indexStubRefs},
 *   {@link indexStubRules}). A stub is never saved ({@link stubNames}); a
 *   helper that scans bodies reads a stub's references and rules instead of
 *   its (absent) body.
 */

import type { QueryClient } from "@tanstack/react-query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  type BatchCall,
  type BatchOutcome,
  ContentProtocolError,
  ErrorCode,
} from "@decocms/blocks/protocol";
import { DRAFT_TOMBSTONE_VERSION } from "@decocms/shared/blocks-major";
import { exponentialBackoffWithJitter } from "@decocms/shared/std";
import { KEYS } from "@/lib/query-keys";
import { keepContentBookkeeping } from "./content-bookkeeping";

/** One name of the overlaid index (latest ⊕ draft), as `cms.index` answers it. */
export interface HostedIndexEntry {
  version: string;
  meta?: { type?: string; path?: string; refs?: string[]; rules?: string[] };
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
/** An index stub's direct references (the index's `meta.refs`). */
const INDEX_STUB_REFS = "__indexRefs";
/** The tests and campaigns an index stub's body uses (the index's `meta.rules`). */
const INDEX_STUB_RULES = "__indexRules";

/** Whether `value` is an index stub (or a copy of one). */
export function isIndexStub(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, INDEX_STUB)
  );
}

/**
 * The names an index stub's block references directly (its index
 * `meta.refs`); `[]` for anything else.
 */
export function indexStubRefs(value: unknown): string[] {
  if (!isIndexStub(value)) return [];
  const refs = (value as Record<string, unknown>)[INDEX_STUB_REFS];
  return Array.isArray(refs)
    ? refs.filter((ref): ref is string => typeof ref === "string")
    : [];
}

/**
 * The names of the A/B tests and campaigns an index stub's block uses (its
 * index `meta.rules`: one list for both kinds); `[]` for anything else.
 */
export function indexStubRules(value: unknown): string[] {
  if (!isIndexStub(value)) return [];
  const rules = (value as Record<string, unknown>)[INDEX_STUB_RULES];
  return Array.isArray(rules)
    ? rules.filter((rule): rule is string => typeof rule === "string")
    : [];
}

/** The names of `set` whose value is an index stub: never written. */
export function stubNames(set: Record<string, unknown> | undefined): string[] {
  return Object.entries(set ?? {})
    .filter(([, value]) => isIndexStub(value))
    .map(([name]) => name);
}

/**
 * Every name of the index, for list views: a loaded body as it is, any
 * other as a stub with its raw type, path, direct references and rules.
 * Index order.
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
      ...(entry.meta?.refs?.length
        ? { [INDEX_STUB_REFS]: entry.meta.refs }
        : {}),
      ...(entry.meta?.rules?.length
        ? { [INDEX_STUB_RULES]: entry.meta.rules }
        : {}),
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

/** The rules that name an A/B test or a campaign by `name`. */
const NAMED_RULE_TYPES: ReadonlySet<unknown> = new Set([
  "experiment",
  "campaign",
]);

function collectTypes(value: unknown, types: Set<string>, rules: Set<string>) {
  if (Array.isArray(value)) {
    for (const item of value) collectTypes(item, types, rules);
    return;
  }
  if (!isRecord(value)) return;
  if (
    NAMED_RULE_TYPES.has(value.__resolveType) &&
    typeof value.name === "string"
  ) {
    rules.add(value.name);
  }
  for (const [key, inner] of Object.entries(value)) {
    if (key === "__resolveType" && typeof inner === "string") types.add(inner);
    else collectTypes(inner, types, rules);
  }
}

/**
 * The index meta of a body this editor just saved (the server's
 * `blockMeta`: `type`, `path`, `refs` and `rules`), so a list shows a new
 * page's path, and the Experiments and Calendar views its uses, before the
 * next poll.
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
  const rules = new Set<string>();
  collectTypes(body, found, rules);
  const refs = [...found].filter((n) => names.has(n)).sort();
  if (refs.length > 0) meta.refs = refs;
  if (rules.size > 0) meta.rules = [...rules].sort();
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

/**
 * The draft's copy of one block, as a refused save carried it, kept in the
 * index: its draft entry and, the index being latest overlaid with the
 * draft, its entry (version, and meta from the body; none for a deletion).
 * The next poll then finds the index as the editor holds it, and doesn't
 * take the change the refusal already showed for a new one.
 */
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
      const entries = { ...index.entries };
      if (stored === null) delete draft[name];
      else {
        draft[name] = {
          operation: stored.block === null ? "delete" : "set",
          version: stored.version,
          editor: draft[name]?.editor ?? null,
        };
        if (stored.block === null) delete entries[name];
        else {
          const names = new Set([...Object.keys(entries), name]);
          const meta = indexMetaOf(stored.block, names);
          entries[name] = {
            version: stored.version,
            ...(meta ? { meta } : {}),
          };
        }
      }
      return { ...index, entries, draft };
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

/**
 * The names whose index entry says their body uses one of `rules` (its
 * `meta.rules`: an A/B test's or a campaign's name, either kind), in index
 * order. What a rename or delete of a test or campaign loads to rewrite or
 * count its uses, instead of every body.
 */
export function indexRuleUsers(
  index: ContentIndex | undefined,
  rules: Iterable<string>,
): string[] {
  const wanted = new Set(rules);
  if (!index || wanted.size === 0) return [];
  return Object.entries(index.entries)
    .filter(([, entry]) => entry.meta?.rules?.some((rule) => wanted.has(rule)))
    .map(([name]) => name);
}

/**
 * The names whose index entry references one of `names` directly (its
 * `meta.refs`), in index order.
 */
export function indexReferrers(
  index: ContentIndex | undefined,
  names: Iterable<string>,
): string[] {
  const wanted = new Set(names);
  if (!index || wanted.size === 0) return [];
  return Object.entries(index.entries)
    .filter(([, entry]) => entry.meta?.refs?.some((ref) => wanted.has(ref)))
    .map(([name]) => name);
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

/** Where a view's {@link useEnsureHostedBlocks} load stands. */
export interface HostedBlocksLoad {
  /** Every name wanted that the index has is loaded (always, off hosted). */
  ready: boolean;
  /** The last load failed; it is tried again on its own, or with `retry`. */
  failed: boolean;
  /** Try the load again now. */
  retry: () => void;
}

/** The longest wait before a failed load is tried again on its own. */
const RETRY_CAP_MS = 30_000;

/** The wait the server asked for (`-32008` `data.retryAfterMs`), if any. */
function retryAfterOf(error: unknown): number | undefined {
  if (!(error instanceof ContentProtocolError)) return undefined;
  const after = (error.data as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof after === "number" && after > 0 ? after : undefined;
}

/**
 * Loads `names` (and the names their bodies reference directly, when
 * `withRefs`) once the index is read, and again when the index moves their
 * versions. A failed load (design "Failures": a failed read is retried by
 * the next one that needs it) is tried again on its own, after the wait the
 * server asked for or with backoff, and says so (`failed`) meanwhile.
 */
export function useEnsureHostedBlocks(
  rpc: HostedRpc | null | undefined,
  cacheKey: string,
  names: readonly string[],
  options?: { withRefs?: boolean },
): HostedBlocksLoad {
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
  // A body wanted and not held (never loaded, or dropped from the cache
  // since) is part of the key, so its load runs again even when the index
  // didn't move its version: the view would otherwise wait on it for good.
  const key = wanted
    .map(
      (name) =>
        `${name}@${index?.entries[name]?.version ?? ""}${
          loaded && Object.hasOwn(loaded, name) ? "" : "!"
        }`,
    )
    .join("\n");
  // The failures of the load of `key` so far, and the attempt to run.
  const [failure, setFailure] = useState<{
    key: string;
    count: number;
    retryAfterMs: number | undefined;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const failures = failure?.key === key ? failure : null;
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- loads what the view opens when the index names it
  useEffect(() => {
    if (!rpc || !key) return;
    let current = true;
    // `key` carries the names wanted and their versions.
    const names = key
      .split("\n")
      .map((line) => line.slice(0, line.lastIndexOf("@")));
    ensureHostedBlocks(queryClient, rpc, cacheKey, names).then(
      () => {
        if (current) setFailure((f) => (f?.key === key ? null : f));
      },
      (error: unknown) => {
        if (!current) return;
        setFailure((f) => ({
          key,
          count: (f?.key === key ? f.count : 0) + 1,
          retryAfterMs: retryAfterOf(error),
        }));
      },
    );
    return () => {
      current = false;
    };
  }, [rpc, queryClient, cacheKey, key, attempt]);
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- a timer that tries a failed load again
  useEffect(() => {
    if (!failures) return;
    const wait = Math.min(
      RETRY_CAP_MS,
      failures.retryAfterMs ??
        exponentialBackoffWithJitter(
          RETRY_CAP_MS,
          1000,
          failures.count - 1,
          2,
          0.5,
        ),
    );
    const timer = setTimeout(() => setAttempt((n) => n + 1), wait);
    return () => clearTimeout(timer);
  }, [failures]);
  return {
    ready: !rpc || !pending,
    failed: !!rpc && pending && failures !== null,
    retry: () => setAttempt((n) => n + 1),
  };
}
