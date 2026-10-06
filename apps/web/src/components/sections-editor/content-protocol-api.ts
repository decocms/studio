/**
 * The editor's reads and writes over the content protocol. The data hooks
 * (`useDecofile`, `useLiveMeta`, the write hooks) call these when the project
 * has a protocol backend, and keep their legacy paths otherwise.
 *
 * Polling follows the protocol: one batched request reads the blocks and the
 * schema, each conditional on the revision (or schema version) last seen, and
 * gets a short "not modified" when nothing changed. After a write the client
 * adopts the returned revision, so its next poll is "not modified" unless
 * someone else wrote.
 */

import { type QueryClient, useQuery } from "@tanstack/react-query";
import { ServeLostError } from "./serve-save-error";
import {
  ContentProtocolError,
  type BlocksListResult,
  type SchemaGetResult,
} from "@decocms/blocks/protocol";
import { KEYS } from "@/lib/query-keys";
import { sandboxGitStatusQueryKey } from "../thread/repository/sandbox-git-api";
import {
  blockKeysOfWrite,
  mergePolledBlocks,
  type ProtocolBackend,
} from "./content-backend";
import {
  type DecofilePatchBody,
  type DecofileScopeParams,
  decofileWriteMutationKey,
  fetchDraftToken,
} from "./decofile-api";
import { buildDraftPointer } from "./section-preview-url";
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

interface ProtocolParams extends DecofileScopeParams {
  threadId?: string | null;
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
      void queryClient.resetQueries({
        queryKey: KEYS.contentBackend(
          params.orgSlug,
          params.virtualMcpId,
          "local",
        ),
      });
      throw new ServeLostError(error);
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
  const currentMeta = queryClient.getQueryData<LiveMeta>(metaKey);
  const seen =
    queryClient.getQueryData<ContentRevisions>(revisionsKey) ?? undefined;
  const blocksIfNoneMatch =
    conditional && currentBlocks ? seen?.revision : undefined;
  const schemaIfNoneMatch =
    conditional && currentMeta ? seen?.schemaVersion : undefined;

  const [listed, schema] = await guarded(queryClient, backend, params, () =>
    backend.client.batch([
      {
        method: "blocks.list",
        params: blocksIfNoneMatch ? { ifNoneMatch: blocksIfNoneMatch } : {},
      },
      {
        method: "schema.get",
        params: schemaIfNoneMatch ? { ifNoneMatch: schemaIfNoneMatch } : {},
      },
    ]),
  );
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

  const blocks = list.notModified
    ? currentBlocks!
    : mergePolledBlocks(
        list.blocks,
        currentBlocks,
        savingBlockKeys(queryClient, params),
      );
  const meta: LiveMeta | ContentProtocolError = absent
    ? noSchemaMeta()
    : !read
      ? (schema as { error: ContentProtocolError }).error
      : read.notModified
        ? currentMeta!
        : (read.schema as LiveMeta);
  queryClient.setQueryData<ContentRevisions>(revisionsKey, {
    revision: list.notModified ? seen?.revision : list.revision,
    schemaVersion: !read
      ? undefined
      : read.notModified
        ? seen?.schemaVersion
        : (read.version ?? undefined),
  });
  queryClient.setQueryData(blocksKey, blocks);
  if (!(meta instanceof ContentProtocolError)) {
    queryClient.setQueryData(metaKey, meta);
  }
  return { blocks, meta };
}

/**
 * One `blocks.apply`; adopts the returned revision. On GitHub the commit
 * moved the branch head, so the header's branch status is refreshed.
 * `ifMatch` guards entries by version (`null`: only if it doesn't exist yet);
 * a failed guard rejects the whole patch with a Conflict.
 */
export async function applyProtocolPatch(
  queryClient: QueryClient,
  backend: ProtocolBackend,
  params: ProtocolParams,
  cacheKey: string,
  patch: DecofilePatchBody,
  ifMatch?: Record<string, string | null>,
): Promise<{ revision: string }> {
  const result = await guarded(queryClient, backend, params, () =>
    backend.client.blocksApply({
      set: patch.set as Record<string, Record<string, unknown>> | undefined,
      delete: patch.delete,
      ...(ifMatch ? { ifMatch } : {}),
    }),
  );
  queryClient.setQueryData<ContentRevisions>(
    KEYS.contentRevision(cacheKey),
    (seen) => ({ ...seen, revision: result.revision }),
  );
  if (backend.source === "github") {
    await queryClient.invalidateQueries({
      queryKey: sandboxGitStatusQueryKey({
        orgSlug: params.orgSlug,
        virtualMcpId: params.virtualMcpId,
        branch: params.branch,
        threadId: params.threadId ?? null,
      }),
    });
  }
  return { revision: result.revision };
}

/**
 * A draft token lives six hours. Each new token changes the pointer and so
 * reloads the preview, so refresh only once, an hour before it expires.
 */
const DRAFT_TOKEN_REFRESH_MS = 5 * 60 * 60_000;

export interface ProtocolDraft {
  /** The `?__draft=` pointer to the branch's changes, or null before a token and a revision. */
  pointer: string | null;
  /** Why the preview's draft token couldn't be fetched, or null ("preview unavailable"). */
  failed: string | null;
}

/**
 * The `?__draft=` pointer of a project on the GitHub backend: the v7 Fast
 * Preview pointer, naming the branch's `changes` against production. Its
 * version is the last revision a read or write saw, so each save refreshes
 * the preview. `params` is `null` for any other backend.
 */
export function useProtocolDraft(
  params: DecofileScopeParams | null,
  cacheKey: string,
): ProtocolDraft {
  const revision = useContentRevision(cacheKey);
  const { data, error } = useQuery({
    queryKey: KEYS.draftToken(cacheKey),
    queryFn: () => fetchDraftToken(params!),
    enabled: !!params,
    staleTime: DRAFT_TOKEN_REFRESH_MS,
    refetchInterval: DRAFT_TOKEN_REFRESH_MS,
  });
  if (!params) return { pointer: null, failed: null };
  return {
    pointer:
      data && revision
        ? buildDraftPointer({
            ...params,
            ...data,
            version: revision,
            suffix: "/changes",
          })
        : null,
    // A token from before a failed refresh still works until it expires.
    failed: !data && error ? error.message || "Preview unavailable" : null,
  };
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
