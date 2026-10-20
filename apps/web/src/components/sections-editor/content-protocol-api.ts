/**
 * The editor's reads and writes over the content protocol. The data hooks
 * (`useDecofile`, `useLiveMeta`, the write hooks) call these when the project
 * has a protocol backend, and keep their legacy paths otherwise.
 *
 * Polling follows the protocol: one batched request reads the blocks, the
 * schema and the changes against the base (`changes.list`), each conditional
 * on the revision (or schema version) last seen, and gets a short "not
 * modified" when nothing changed. After a write the client
 * adopts the returned revision, so its next poll is "not modified" unless
 * someone else wrote.
 */

import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  isMainSchemaChangedResponse,
  MainSchemaChangedError,
  mainSchemaHeaders,
  mainSchemaRead,
  resetMainSchemaAnswer,
} from "@/hooks/main-schema-changed";
import { ServeLostError } from "./serve-save-error";
import {
  ContentProtocolError,
  type BlocksListResult,
  type ChangesGetResult,
  type ChangesListResult,
  type SchemaGetResult,
} from "@decocms/blocks/protocol";
import { KEYS } from "@/lib/query-keys";
import {
  adoptChangesList,
  type ContentChanges,
  isOutdatedServerError,
} from "./content-changes";
import { externalContentChange, runContentChange } from "./content-sync";
import {
  blockKeysOfWrite,
  mergePolledBlocks,
  type ProtocolBackend,
} from "./content-backend";
import {
  type DecofilePatchBody,
  type DecofileScopeParams,
  decofileWriteMutationKey,
} from "./decofile-api";
import type { LiveMeta } from "./resolve-schema";
import { isSchemaAbsent, noSchemaMeta } from "./schemaless";

/**
 * The read error while a protocol backend can't be used; the 502 keeps the
 * hooks' retry rules and the blocks tab's "unreachable" state.
 */
export function protocolUnavailableError(what: string): Error {
  const error = new Error(`${what} unavailable (content server unreachable)`);
  (error as { status?: number }).status = 502;
  return error;
}

/** What a project's last read or write saw. */
export interface ContentRevisions {
  /** The blocks revision (the branch head on GitHub). */
  revision?: string;
  schemaVersion?: string;
}

/** The cache entry of a protocol project's schema (a `useLiveMeta` key). */
export function protocolMetaQueryKey(
  params: DecofileScopeParams,
  backend: ProtocolBackend,
) {
  return KEYS.liveMeta(
    params.orgSlug,
    params.virtualMcpId,
    params.branch,
    `protocol${backend.cacheKeySuffix}`,
    "",
  );
}

/**
 * Per block, the version (`blocks.list`'s, opaque) of the copy in the
 * editor's blocks cache, as last read or written: what a `blocks.apply`
 * guard (`ifMatch`) built on that copy expects. A block an in-flight write
 * holds keeps the version of its last landed copy. `null`: the content has
 * no such block. Undefined when unknown (before the first full read).
 */
export function protocolBlockVersion(
  queryClient: QueryClient,
  cacheKey: string,
  blockKey: string,
): string | null | undefined {
  const versions = queryClient.getQueryData<Record<string, string>>(
    KEYS.contentVersions(cacheKey),
  );
  if (!versions) return undefined;
  if (Object.hasOwn(versions, blockKey)) return versions[blockKey];
  // Absent from the versions: absent from the content (`null`), unless the
  // cache holds the block anyway (a write of it not yet answered): unknown.
  const blocks = queryClient.getQueryData<Record<string, unknown>>(
    KEYS.decofile(cacheKey),
  );
  return blocks && Object.hasOwn(blocks, blockKey) ? undefined : null;
}

/** Records versions a write or read answered (`null`: the block is gone). */
function adoptBlockVersions(
  queryClient: QueryClient,
  cacheKey: string,
  versions: Record<string, string | null>,
) {
  queryClient.setQueryData<Record<string, string>>(
    KEYS.contentVersions(cacheKey),
    (current) => {
      const next = { ...current };
      for (const [name, version] of Object.entries(versions)) {
        if (version === null) delete next[name];
        else next[name] = version;
      }
      return next;
    },
  );
}

/** The block names the project's in-flight writes touch. */
function savingBlockKeys(
  queryClient: QueryClient,
  params: DecofileScopeParams,
): Set<string> {
  const pending = queryClient.getMutationCache().findAll({
    mutationKey: decofileWriteMutationKey(
      params.orgSlug,
      params.virtualMcpId,
      params.branch,
    ),
    status: "pending",
  });
  return new Set(pending.flatMap((m) => blockKeysOfWrite(m.state.variables)));
}

/** Resets a `deco serve`'s probe, so the editor says where it stands and reconnects. */
function resetLocalProbe(
  queryClient: QueryClient,
  params: DecofileScopeParams,
) {
  void queryClient.resetQueries({
    queryKey: KEYS.contentBackend(params.orgSlug, params.virtualMcpId, "local"),
  });
}

/**
 * Runs a request against the backend. When a `deco serve` can't be reached
 * (it stopped or is restarting), its probe is reset, so the editor waits for
 * it and reconnects on its own.
 */
async function guarded<T>(
  queryClient: QueryClient,
  backend: ProtocolBackend,
  params: DecofileScopeParams,
  request: () => Promise<T>,
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    const lostServer = !(error instanceof ContentProtocolError);
    if (backend.source === "local" && lostServer) {
      resetLocalProbe(queryClient, params);
      throw new ServeLostError(error);
    }
    // An older `deco serve` took its place: the probe says it's out of date.
    if (backend.source === "local" && isOutdatedServerError(error)) {
      resetLocalProbe(queryClient, params);
    }
    throw error;
  }
}

export interface ProtocolContent {
  blocks: Record<string, unknown>;
  /** The schema (`noSchemaMeta()` while there is none), or the error reading it. */
  meta: LiveMeta | ContentProtocolError;
}

const inFlight = new Map<string, Promise<ProtocolContent>>();

/**
 * One poll: `blocks.list` and `schema.get` in one request. Updates both the
 * decofile and the schema cache entries and resolves with both, so the two
 * hooks share one request (concurrent calls for one project join it).
 */
export function pollProtocolContent(
  queryClient: QueryClient,
  backend: ProtocolBackend,
  params: DecofileScopeParams,
  cacheKey: string,
): Promise<ProtocolContent> {
  const running = inFlight.get(cacheKey);
  if (running) return running;
  const poll = readContent(queryClient, backend, params, cacheKey, true);
  inFlight.set(cacheKey, poll);
  return poll.finally(() => inFlight.delete(cacheKey));
}

async function readContent(
  queryClient: QueryClient,
  backend: ProtocolBackend,
  params: DecofileScopeParams,
  cacheKey: string,
  conditional: boolean,
): Promise<ProtocolContent> {
  const blocksKey = KEYS.decofile(cacheKey);
  const metaKey = protocolMetaQueryKey(params, backend);
  const revisionsKey = KEYS.contentRevision(cacheKey);
  const currentBlocks =
    queryClient.getQueryData<Record<string, unknown>>(blocksKey);
  const cachedMeta = queryClient.getQueryData<LiveMeta>(metaKey);
  const cachedRevisions =
    queryClient.getQueryData<ContentRevisions>(revisionsKey) ?? undefined;
  // Studio's GitHub backend serves main's schema, which the page already read
  // to decide v8 (`mainSchemaRead`): the first poll starts from it and asks
  // only whether it changed.
  const main =
    backend.source === "github" && !cachedMeta
      ? mainSchemaRead(queryClient, params.orgSlug, params.virtualMcpId)
      : undefined;
  const seeded = main?.isV8 && main.schema && main.version ? main : undefined;
  const currentMeta = cachedMeta ?? (seeded?.schema as LiveMeta | undefined);
  const seen: ContentRevisions | undefined = seeded
    ? { ...cachedRevisions, schemaVersion: seeded.version! }
    : cachedRevisions;
  const blocksIfNoneMatch =
    conditional && currentBlocks ? seen?.revision : undefined;
  const schemaIfNoneMatch =
    conditional && currentMeta ? seen?.schemaVersion : undefined;
  const changesKey = KEYS.contentChanges(cacheKey);
  const seenChanges = queryClient.getQueryData<ContentChanges>(changesKey);

  const [listed, schema, changed] = await guarded(
    queryClient,
    backend,
    params,
    () =>
      backend.client.batch([
        {
          method: "blocks.list",
          params: blocksIfNoneMatch ? { ifNoneMatch: blocksIfNoneMatch } : {},
        },
        {
          method: "schema.get",
          params: schemaIfNoneMatch ? { ifNoneMatch: schemaIfNoneMatch } : {},
        },
        {
          method: "changes.list",
          params: seenChanges ? { ifNoneMatch: seenChanges.revision } : {},
        },
      ]),
  );
  // The changes ride along: a failure there never fails the content read
  // (the list says so where it's shown), except an older `deco serve`,
  // which the editor explains.
  if (changed?.ok) {
    const adopted = adoptChangesList(
      seenChanges,
      changed.result as ChangesListResult,
    );
    if (adopted) queryClient.setQueryData(changesKey, adopted);
  } else if (
    changed &&
    backend.source === "local" &&
    isOutdatedServerError(changed.error)
  ) {
    resetLocalProbe(queryClient, params);
  }
  if (!listed?.ok) throw listed?.error ?? new Error("no blocks.list");
  if (!schema) throw new Error("no schema.get");
  const list = listed.result as BlocksListResult;
  // No schema yet: an empty, marked schema, so the blocks still open (as
  // plain fields) and the next poll asks again unconditionally.
  const absent = isSchemaAbsent(schema);
  const read = schema.ok && !absent ? (schema.result as SchemaGetResult) : null;
  // A version outlived the entry it described: read both whole.
  if (
    (list.notModified && !currentBlocks) ||
    (read?.notModified && !currentMeta)
  ) {
    return readContent(queryClient, backend, params, cacheKey, false);
  }

  const saving = list.notModified
    ? new Set<string>()
    : savingBlockKeys(queryClient, params);
  const blocks = list.notModified
    ? currentBlocks!
    : mergePolledBlocks(list.blocks, currentBlocks, saving);
  const meta: LiveMeta | ContentProtocolError = absent
    ? noSchemaMeta()
    : !read
      ? (schema as { error: ContentProtocolError }).error
      : read.notModified
        ? currentMeta!
        : (read.schema as LiveMeta);
  // This editor wrote while the poll ran (a write adopts its revision): the
  // poll may have listed before that write, so it neither moves the revision
  // back nor reads the write as someone else's change.
  const adopted =
    queryClient.getQueryData<ContentRevisions>(revisionsKey)?.revision;
  const raced = adopted !== undefined && adopted !== seen?.revision;
  queryClient.setQueryData<ContentRevisions>(revisionsKey, {
    revision: raced
      ? adopted
      : list.notModified
        ? seen?.revision
        : list.revision,
    schemaVersion: !read
      ? undefined
      : read.notModified
        ? seen?.schemaVersion
        : (read.version ?? undefined),
  });
  queryClient.setQueryData(blocksKey, blocks);
  if (!list.notModified) {
    // Versions follow the copies kept: a block being saved keeps the
    // version of its last landed copy until its write answers.
    const versionsKey = KEYS.contentVersions(cacheKey);
    const previous =
      queryClient.getQueryData<Record<string, string>>(versionsKey);
    const versions: Record<string, string> = { ...list.versions };
    for (const key of saving) {
      const kept = previous?.[key];
      if (kept !== undefined) versions[key] = kept;
      else delete versions[key];
    }
    queryClient.setQueryData(versionsKey, versions);
  }
  if (!(meta instanceof ContentProtocolError)) {
    queryClient.setQueryData(metaKey, meta);
  }
  // A revision this editor didn't write (its writes adopt theirs): someone
  // else changed the content, so the rest of the editor catches up too.
  if (
    !raced &&
    !list.notModified &&
    currentBlocks &&
    seen?.revision &&
    list.revision !== seen.revision
  ) {
    externalContentChange({
      queryClient,
      orgSlug: params.orgSlug,
      virtualMcpId: params.virtualMcpId,
      branch: params.branch,
      backend,
      cacheKey,
    });
  }
  return { blocks, meta };
}

/**
 * One `blocks.apply` (an edit), run as a content change (content-sync.ts): it
 * adopts the returned revision, and the shared refresh re-reads what the
 * write moved: on GitHub the CDN draft (the draft pointer, `useProtocolDraft`,
 * whose version is the draft's ETag, so the preview reloads) and the publish
 * status; in a sandbox the header's status. The form's own save hook updates
 * the blocks cache.
 * `ifMatch` guards entries by version (`null`: only if it doesn't exist yet);
 * a failed guard rejects the whole patch with a Conflict.
 */
export async function applyProtocolPatch(
  queryClient: QueryClient,
  backend: ProtocolBackend,
  params: DecofileScopeParams,
  cacheKey: string,
  patch: DecofilePatchBody,
  ifMatch?: Record<string, string | null>,
): Promise<{ revision: string; versions: Record<string, string | null> }> {
  return runContentChange(
    {
      queryClient,
      orgSlug: params.orgSlug,
      virtualMcpId: params.virtualMcpId,
      branch: params.branch,
      backend,
      cacheKey,
    },
    {
      kind: "edit",
      write: async () => {
        const result = await guarded(queryClient, backend, params, () =>
          backend.client.blocksApply({
            set: patch.set as
              | Record<string, Record<string, unknown>>
              | undefined,
            delete: patch.delete,
            ...(ifMatch ? { ifMatch } : {}),
          }),
        );
        queryClient.setQueryData<ContentRevisions>(
          KEYS.contentRevision(cacheKey),
          (seen) => ({ ...seen, revision: result.revision }),
        );
        const versions = result.versions ?? {};
        adoptBlockVersions(queryClient, cacheKey, versions);
        return { revision: result.revision, versions };
      },
    },
  );
}

/**
 * After a save refused for an outdated `ifMatch`: reads the content again and
 * puts the block's stored copy (and its version) in the cache, in place of
 * the refused edit. The poll keeps a block that is being saved as the editor
 * holds it, so the block itself comes from `changes.get` (or, on a server
 * without it, an unconditional `blocks.list`).
 */
export async function reloadProtocolBlock(
  queryClient: QueryClient,
  backend: ProtocolBackend,
  params: DecofileScopeParams,
  cacheKey: string,
  blockKey: string,
): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: KEYS.decofile(cacheKey) });
  let stored: { value: Record<string, unknown> | null; version: string | null };
  try {
    const read: ChangesGetResult = await guarded(
      queryClient,
      backend,
      params,
      () => backend.client.changesGet({ names: [blockKey] }),
    );
    const entry = read.entries[blockKey];
    // Present but unreadable now: nothing better to show than the cache.
    if (entry && entry.after === null && entry.version !== null) return;
    stored = { value: entry?.after ?? null, version: entry?.version ?? null };
  } catch {
    const list = await guarded(queryClient, backend, params, () =>
      backend.client.blocksList({}),
    );
    if (list.notModified) return;
    stored = {
      value: list.blocks[blockKey] ?? null,
      version: list.versions[blockKey] ?? null,
    };
  }
  queryClient.setQueryData(
    KEYS.decofile(cacheKey),
    (current: Record<string, unknown> | undefined) => {
      const next = { ...current };
      if (stored.value === null) delete next[blockKey];
      else next[blockKey] = stored.value;
      return next;
    },
  );
  adoptBlockVersions(queryClient, cacheKey, { [blockKey]: stored.version });
}

/** What the session read answers for a hosted v8 project. */
interface HostedDraftPointer {
  /** `delivery.decocms.com/sites/<site>/drafts/<slug>.json`; null without a draft. */
  draft: string | null;
  /** The draft object's ETag, so each save makes a new pointer. */
  version: string | null;
}

/**
 * The `?__draft=` pointer of a project on the GitHub backend: its draft on
 * the delivery CDN, `<draft>@<etag>`, which the site's SDK revalidates on
 * every render. Read from the session's decofile GET, on load and again
 * after each content change (content-sync.ts). `params` is `null` for any
 * other backend; the pointer is null while there is no draft.
 */
export function useProtocolDraft(
  params: DecofileScopeParams | null,
): string | null {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: KEYS.protocolDraftRead(
      params?.orgSlug ?? "",
      params?.virtualMcpId ?? "",
      params?.branch ?? "",
    ),
    queryFn: async (): Promise<HostedDraftPointer> => {
      const res = await fetch(
        `/api/${params!.orgSlug}/decofile/${encodeURIComponent(params!.virtualMcpId)}/${encodeURIComponent(params!.branch)}`,
        { cache: "no-store", headers: mainSchemaHeaders("v8") },
      );
      // Main is no longer v8: the editor re-reads main's answer.
      if (await isMainSchemaChangedResponse(res)) {
        resetMainSchemaAnswer(
          queryClient,
          params!.orgSlug,
          params!.virtualMcpId,
        );
        throw new MainSchemaChangedError();
      }
      if (!res.ok) throw new Error(`draft pointer read failed: ${res.status}`);
      return (await res.json()) as HostedDraftPointer;
    },
    enabled: !!params,
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (!params || !data?.draft || !data.version) return null;
  return `${data.draft}@${data.version}`;
}

/**
 * The content revision the last read or write of `cacheKey` saw, or
 * `undefined` before the first one. A save moves it, and so does a read that
 * finds the content changed elsewhere.
 */
export function useContentRevision(cacheKey: string): string | undefined {
  const { data: seen } = useQuery<ContentRevisions>({
    queryKey: KEYS.contentRevision(cacheKey),
    enabled: false,
    queryFn: async () => {
      throw new Error("content revisions are set by reads and writes");
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
  return seen?.revision;
}
