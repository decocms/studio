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
import { useEffect } from "react";
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
  type BlocksApplyResult,
  type BlocksListResult,
  type ChangesGetResult,
  type ChangesListResult,
  type SchemaGetResult,
  spellingKey,
} from "@decocms/blocks/protocol";
import {
  DRAFT_TOMBSTONE_VERSION,
  type DraftConflictBlocks,
  hostedRevision,
  hostedRevisionParts,
} from "@decocms/shared/blocks-major";
import { KEYS } from "@/lib/query-keys";
import { keepContentBookkeeping } from "./content-bookkeeping";
import {
  adoptChangesList,
  type ContentChanges,
  isOutdatedServerError,
} from "./content-changes";
import { externalContentChange, runContentChange } from "./content-sync";
import { onContentWrittenElsewhere } from "./content-writes-channel";
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
 * Per block, the version a `blocks.apply` guard (`ifMatch`) built on the
 * editor's copy expects. `null`: the guard is "must not exist yet".
 * Undefined when unknown (before the first full read): the caller reads
 * first.
 *
 * - Studio's hosted backend (`backend.source === "github"`) checks a save
 *   against the draft alone: a block's version in the draft, as the draft's
 *   changes list it (`changes.list`, which is the draft's own blocks), the
 *   tombstone's (`DRAFT_TOMBSTONE_VERSION`) for a block the draft deletes,
 *   or `null` when the draft doesn't hold it (main's copy is not the
 *   draft's).
 * - Every other backend: the version (`blocks.list`'s, opaque) of the copy
 *   in the editor's blocks cache, as last read or written. A block an
 *   in-flight write holds keeps the version of its last landed copy.
 */
export function protocolBlockVersion(
  queryClient: QueryClient,
  cacheKey: string,
  blockKey: string,
  backend?: Pick<ProtocolBackend, "source"> | null,
): string | null | undefined {
  if (backend?.source === "github") {
    return draftBlockVersion(queryClient, cacheKey, blockKey);
  }
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

/** A hosted draft's change of `blockKey`, under any spelling of its name. */
function draftChangeOf(listed: ContentChanges, blockKey: string) {
  if (Object.hasOwn(listed.changes, blockKey)) return listed.changes[blockKey];
  const key = spellingKey(blockKey);
  const name = Object.keys(listed.changes).find((n) => spellingKey(n) === key);
  return name === undefined ? undefined : listed.changes[name];
}

/** `blockKey`'s version in the hosted draft (see {@link protocolBlockVersion}). */
function draftBlockVersion(
  queryClient: QueryClient,
  cacheKey: string,
  blockKey: string,
): string | null | undefined {
  const listed = queryClient.getQueryData<ContentChanges>(
    KEYS.contentChanges(cacheKey),
  );
  if (!listed) return undefined;
  const change = draftChangeOf(listed, blockKey);
  // A deletion is in the draft: its tombstone is its version.
  if (change?.kind === "delete") {
    return change.version ?? DRAFT_TOMBSTONE_VERSION;
  }
  if (change) return change.version;
  return draftTombstones(queryClient, cacheKey).has(spellingKey(blockKey))
    ? DRAFT_TOMBSTONE_VERSION
    : null;
}

function draftTombstones(
  queryClient: QueryClient,
  cacheKey: string,
): Set<string> {
  return new Set(
    queryClient.getQueryData<string[]>(KEYS.contentDraftTombstones(cacheKey)),
  );
}

/**
 * Records whether the draft deletes `name`, a block main doesn't have (the
 * draft's changes don't list it), for {@link draftBlockVersion}.
 */
function markDraftTombstone(
  queryClient: QueryClient,
  cacheKey: string,
  name: string,
  deleted: boolean,
) {
  const key = spellingKey(name);
  const known = draftTombstones(queryClient, cacheKey);
  if (known.has(key) === deleted) return;
  if (deleted) known.add(key);
  else known.delete(key);
  keepContentBookkeeping(queryClient);
  queryClient.setQueryData<string[]>(KEYS.contentDraftTombstones(cacheKey), [
    ...known,
  ]);
}

/**
 * A hosted save's answer, kept with no read: its revision takes the main
 * part of the revision last read (a save never reads main, so it answers an
 * empty one: `hostedRevision`), so the next poll is "not modified" unless
 * someone else wrote; the draft's changes list gets the saved blocks (each
 * one's "before" is the copy the editor read from main, its version in
 * `KEYS.contentVersions` until now); and the preview's pointer moves to the
 * draft's new version, so the preview reloads.
 */
function adoptHostedSave(
  queryClient: QueryClient,
  params: DecofileScopeParams,
  cacheKey: string,
  result: BlocksApplyResult,
): string {
  const revisionParts = hostedRevisionParts(result.revision);
  const seen = queryClient.getQueryData<ContentRevisions>(
    KEYS.contentRevision(cacheKey),
  )?.revision;
  const read = seen ? hostedRevisionParts(seen) : null;
  const revision =
    revisionParts && !revisionParts.main && read
      ? hostedRevision(read.main, revisionParts.draft)
      : result.revision;
  const versions = queryClient.getQueryData<Record<string, string>>(
    KEYS.contentVersions(cacheKey),
  );
  // A deletion answers `null` (a server on protocol 1.2 answers the
  // tombstone's version): either way the block is gone from the draft.
  const answered = Object.entries(result.versions ?? {}).map(
    ([name, version]): [string, string | null] => [
      name,
      version === DRAFT_TOMBSTONE_VERSION ? null : version,
    ],
  );
  const listedBefore = queryClient.getQueryData<ContentChanges>(
    KEYS.contentChanges(cacheKey),
  );
  /** Names the save answers whose "before" is no block (main lacks them). */
  const mainLess = new Set(
    answered.flatMap(([name]) => {
      const had = listedBefore ? draftChangeOf(listedBefore, name) : undefined;
      const baseVersion = had ? had.baseVersion : (versions?.[name] ?? null);
      return baseVersion === null ? [name] : [];
    }),
  );
  // Spellings the save wrote: another spelling's `null` is no deletion.
  const written = new Set(
    answered.flatMap(([name, version]) =>
      version === null ? [] : [spellingKey(name)],
    ),
  );
  queryClient.setQueryData<ContentChanges>(
    KEYS.contentChanges(cacheKey),
    (listed) => {
      if (!listed) return listed;
      const changes = { ...listed.changes };
      for (const [name, version] of answered) {
        const had = draftChangeOf(listed, name);
        const baseVersion = had ? had.baseVersion : (versions?.[name] ?? null);
        if (version !== null) {
          changes[name] = { kind: "set", version, baseVersion };
        } else if (baseVersion !== null) {
          changes[name] = { kind: "delete", version: null, baseVersion };
        } else delete changes[name];
      }
      // Same revision: the next poll lists the changes whole (the server's
      // moved), and in the meantime this is the draft.
      return { ...listed, changes };
    },
  );
  for (const [name, version] of answered) {
    if (version !== null) {
      markDraftTombstone(queryClient, cacheKey, name, false);
    } else if (!written.has(spellingKey(name)) && mainLess.has(name)) {
      // A block main doesn't have, deleted: the draft holds its tombstone.
      markDraftTombstone(queryClient, cacheKey, name, true);
    }
  }
  if (revisionParts && revisionParts.draft !== "none") {
    queryClient.setQueryData<HostedDraftPointer>(
      KEYS.protocolDraftRead(
        params.orgSlug,
        params.virtualMcpId,
        params.branch,
      ),
      (pointer) =>
        pointer ? { ...pointer, version: revisionParts.draft } : pointer,
    );
  }
  return revision;
}

/** Records versions a write or read answered (`null`: the block is gone). */
function adoptBlockVersions(
  queryClient: QueryClient,
  cacheKey: string,
  versions: Record<string, string | null>,
) {
  keepContentBookkeeping(queryClient);
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
export function savingBlockKeys(
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

const rereading = new Set<string>();

/**
 * Reads the content again as soon as another view of this draft in the
 * browser (a tab or window) saved it, so this view's next change is built on
 * that save rather than refused as "changed while you were editing".
 */
export function useRereadOnWriteElsewhere(
  backend: ProtocolBackend | null,
  params: DecofileScopeParams | null,
  cacheKey: string,
) {
  const queryClient = useQueryClient();
  const orgSlug = params?.orgSlug;
  const virtualMcpId = params?.virtualMcpId;
  const branch = params?.branch;
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- subscribes to the browser's other views for the component's lifetime
  useEffect(() => {
    if (!backend || !orgSlug || !virtualMcpId || !branch) return;
    const scope = { orgSlug, virtualMcpId, branch };
    return onContentWrittenElsewhere((written) => {
      if (written !== cacheKey) return;
      // Every view of the draft in this page shares one read.
      if (rereading.has(cacheKey)) return;
      rereading.add(cacheKey);
      void rereadProtocolContent(queryClient, backend, scope, cacheKey)
        .catch(() => {})
        .finally(() => rereading.delete(cacheKey));
    });
  }, [queryClient, backend, orgSlug, virtualMcpId, branch, cacheKey]);
}

/**
 * A read that starts now, for a check that must see what is stored at the
 * moment of a click (another tab may have changed the draft): a poll already
 * running may have listed before, so it is waited out and the source asked
 * again. Conditional on the revision held, so an unchanged draft costs no
 * body; either way the cache then holds the stored blocks and versions.
 */
export async function rereadProtocolContent(
  queryClient: QueryClient,
  backend: ProtocolBackend,
  params: DecofileScopeParams,
  cacheKey: string,
): Promise<ProtocolContent> {
  const running = inFlight.get(cacheKey);
  if (running) await running.catch(() => {});
  return pollProtocolContent(queryClient, backend, params, cacheKey);
}

async function readContent(
  queryClient: QueryClient,
  backend: ProtocolBackend,
  params: DecofileScopeParams,
  cacheKey: string,
  conditional: boolean,
): Promise<ProtocolContent> {
  keepContentBookkeeping(queryClient);
  const blocksKey = KEYS.decofile(cacheKey);
  const metaKey = protocolMetaQueryKey(params, backend);
  const revisionsKey = KEYS.contentRevision(cacheKey);
  const versionsKey = KEYS.contentVersions(cacheKey);
  const currentBlocks =
    queryClient.getQueryData<Record<string, unknown>>(blocksKey);
  // The blocks' versions go with them: without both, read them whole.
  const currentVersions =
    queryClient.getQueryData<Record<string, string>>(versionsKey);
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
    conditional && currentBlocks && currentVersions
      ? seen?.revision
      : undefined;
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
  // This editor wrote while the poll ran (a write adopts its revision): the
  // poll may have listed before that write, so its lists are older than
  // what the write left in the cache.
  const adopted =
    queryClient.getQueryData<ContentRevisions>(revisionsKey)?.revision;
  const raced = adopted !== undefined && adopted !== seen?.revision;
  // The changes ride along: a failure there never fails the content read
  // (the list says so where it's shown), except an older `deco serve`,
  // which the editor explains.
  if (changed?.ok) {
    const listedChanges = raced
      ? null
      : adoptChangesList(seenChanges, changed.result as ChangesListResult);
    if (listedChanges) queryClient.setQueryData(changesKey, listedChanges);
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
    (list.notModified && (!currentBlocks || !currentVersions)) ||
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
  // A raced poll neither moves the revision back nor reads the write as
  // someone else's change.
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
 * adopts the returned revision. On GitHub (Studio's hosted draft) the answer
 * alone updates the draft pointer (`useProtocolDraft`, whose version is the
 * draft's ETag, so the preview reloads) and the changes list, with no read
 * ({@link adoptHostedSave}); in a sandbox or on Localhost the shared refresh
 * re-reads the changes and the header's status. The form's own save hook
 * updates the blocks cache.
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
      adopted: backend.source === "github",
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
        keepContentBookkeeping(queryClient);
        const revision =
          backend.source === "github"
            ? adoptHostedSave(queryClient, params, cacheKey, result)
            : result.revision;
        queryClient.setQueryData<ContentRevisions>(
          KEYS.contentRevision(cacheKey),
          (seen) => ({ ...seen, revision }),
        );
        const versions = result.versions ?? {};
        adoptBlockVersions(queryClient, cacheKey, versions);
        return { revision, versions };
      },
    },
  );
}

/**
 * The draft's copy of `blockKey` that a refused hosted save carries
 * (`DraftConflictBlocks`). Undefined when it carries none, or when the
 * draft doesn't hold the block (main's copy shows, which is read).
 */
function refusedDraftBlock(
  refusal: unknown,
  blockKey: string,
): { block: unknown; version: string } | undefined {
  if (!(refusal instanceof ContentProtocolError)) return undefined;
  const draft = (refusal.data as Partial<DraftConflictBlocks> | null)?.draft;
  if (!draft || typeof draft !== "object" || !Object.hasOwn(draft, blockKey)) {
    return undefined;
  }
  const entry = draft[blockKey];
  return entry && typeof entry.version === "string" ? entry : undefined;
}

/**
 * A refused hosted save says which of its blocks the draft doesn't hold at
 * all (`null` in `DraftConflictBlocks`): a tombstone this editor recorded
 * for one of them is gone (a Publish or discard emptied it), so the block
 * is guarded "must not exist in the draft" again.
 */
function forgetRefusedTombstones(
  queryClient: QueryClient,
  cacheKey: string,
  refusal: unknown,
) {
  if (!(refusal instanceof ContentProtocolError)) return;
  const draft = (refusal.data as Partial<DraftConflictBlocks> | null)?.draft;
  if (!draft || typeof draft !== "object") return;
  for (const [name, entry] of Object.entries(draft)) {
    if (entry === null) markDraftTombstone(queryClient, cacheKey, name, false);
  }
}

/**
 * Puts the draft's copy of `blockKey`, as a refused hosted save carried it,
 * in the cache in place of the refused edit: the block (or its absence, for
 * a block the draft deletes), its version, and its entry in the draft's
 * changes, which the next guard reads (`protocolBlockVersion`).
 */
function adoptRefusedDraftBlock(
  queryClient: QueryClient,
  cacheKey: string,
  blockKey: string,
  stored: { block: unknown; version: string },
) {
  keepContentBookkeeping(queryClient);
  const deleted = stored.block === null;
  const versions = queryClient.getQueryData<Record<string, string>>(
    KEYS.contentVersions(cacheKey),
  );
  const listed = queryClient.getQueryData<ContentChanges>(
    KEYS.contentChanges(cacheKey),
  );
  const had = listed ? draftChangeOf(listed, blockKey) : undefined;
  const baseVersion = had ? had.baseVersion : (versions?.[blockKey] ?? null);
  if (listed) {
    const key = spellingKey(blockKey);
    const changes = Object.fromEntries(
      Object.entries(listed.changes).filter(([n]) => spellingKey(n) !== key),
    );
    if (!deleted) {
      changes[blockKey] = { kind: "set", version: stored.version, baseVersion };
    } else if (baseVersion !== null) {
      changes[blockKey] = { kind: "delete", version: null, baseVersion };
    }
    queryClient.setQueryData<ContentChanges>(KEYS.contentChanges(cacheKey), {
      ...listed,
      changes,
    });
  }
  markDraftTombstone(
    queryClient,
    cacheKey,
    blockKey,
    deleted && baseVersion === null,
  );
  queryClient.setQueryData(
    KEYS.decofile(cacheKey),
    (current: Record<string, unknown> | undefined) => {
      const next = { ...current };
      if (deleted) delete next[blockKey];
      else next[blockKey] = stored.block;
      return next;
    },
  );
  adoptBlockVersions(queryClient, cacheKey, {
    [blockKey]: deleted ? null : stored.version,
  });
}

/**
 * A refused hosted save's blocks, as the draft holds them (the refusal
 * carries them), put in the cache in place of the refused edits. False,
 * adopting nothing, when the refusal doesn't carry every one of them (one
 * the draft doesn't hold shows main's copy: the caller reads it).
 */
export function adoptRefusedDraft(
  queryClient: QueryClient,
  backend: Pick<ProtocolBackend, "source">,
  cacheKey: string,
  refusal: unknown,
): boolean {
  if (backend.source !== "github" || !(refusal instanceof ContentProtocolError))
    return false;
  forgetRefusedTombstones(queryClient, cacheKey, refusal);
  const draft = (refusal.data as Partial<DraftConflictBlocks> | null)?.draft;
  if (!draft || typeof draft !== "object") return false;
  const names = Object.keys(draft);
  const stored = names.map((name) => refusedDraftBlock(refusal, name));
  if (names.length === 0 || stored.some((s) => s === undefined)) return false;
  void queryClient.cancelQueries({ queryKey: KEYS.decofile(cacheKey) });
  names.forEach((name, i) => {
    adoptRefusedDraftBlock(queryClient, cacheKey, name, stored[i]!);
  });
  return true;
}

/**
 * After a save refused for an outdated `ifMatch`: puts the block's stored
 * copy (and its version) in the cache, in place of the refused edit. On
 * Studio's hosted backend the refusal (`refusal`, the save's error) carries
 * the draft's copy, so nothing is read. Otherwise the content is read again;
 * the poll keeps a block that is being saved as the editor holds it, so the
 * block itself comes from `changes.get` (or, on a server without it, an
 * unconditional `blocks.list`). True when the refusal carried the copy.
 */
export async function reloadProtocolBlock(
  queryClient: QueryClient,
  backend: ProtocolBackend,
  params: DecofileScopeParams,
  cacheKey: string,
  blockKey: string,
  refusal?: unknown,
): Promise<boolean> {
  if (backend.source === "github") {
    forgetRefusedTombstones(queryClient, cacheKey, refusal);
  }
  const fromDraft =
    backend.source === "github"
      ? refusedDraftBlock(refusal, blockKey)
      : undefined;
  if (fromDraft) {
    void queryClient.cancelQueries({ queryKey: KEYS.decofile(cacheKey) });
    adoptRefusedDraftBlock(queryClient, cacheKey, blockKey, fromDraft);
    return true;
  }
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
    if (entry && entry.after === null && entry.version !== null) {
      return false;
    }
    stored = { value: entry?.after ?? null, version: entry?.version ?? null };
    // The hosted guards are the draft's versions (`protocolBlockVersion`):
    // the draft's changes follow what was just read.
    if (backend.source === "github") {
      queryClient.setQueryData<ContentChanges>(
        KEYS.contentChanges(cacheKey),
        (listed) => {
          if (!listed) return listed;
          const changes = { ...listed.changes };
          if (entry?.kind) {
            changes[blockKey] = {
              kind: entry.kind,
              version: entry.version,
              baseVersion: entry.baseVersion,
            };
          } else delete changes[blockKey];
          return { ...listed, changes };
        },
      );
    }
  } catch {
    const list = await guarded(queryClient, backend, params, () =>
      backend.client.blocksList({}),
    );
    if (list.notModified) return false;
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
  return false;
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
 * other backend. An editor session's read creates the draft (empty) when
 * there is none, and Publish empties it at the same address, so the pointer
 * is null only before the first answer (`pending`) or when the server has
 * no draft store.
 */
export function useProtocolDraftRead(params: DecofileScopeParams | null): {
  pointer: string | null;
  /** The first read hasn't answered yet (no data, no error). */
  pending: boolean;
} {
  const queryClient = useQueryClient();
  const { data, isPending, isError } = useQuery({
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
  const pending = !!params && isPending && !isError;
  if (!params || !data?.draft || !data.version) {
    return { pointer: null, pending };
  }
  return { pointer: `${data.draft}@${data.version}`, pending: false };
}

/** {@link useProtocolDraftRead}'s pointer alone. */
export function useProtocolDraft(
  params: DecofileScopeParams | null,
): string | null {
  return useProtocolDraftRead(params).pointer;
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
