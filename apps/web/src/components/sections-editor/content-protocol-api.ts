/**
 * The editor's reads and writes over the content protocol. The data hooks
 * (`useDecofile`, `useLiveMeta`, the write hooks) call these when the project
 * has a protocol backend, and keep their legacy paths otherwise.
 *
 * Polling follows the protocol: each read carries the revision (or schema
 * version) it last saw and gets a short "not modified" when nothing changed;
 * after a write the client adopts the returned revision, so its next poll is
 * "not modified" unless someone else wrote.
 */

import type { QueryClient } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import {
  blockKeysOfWrite,
  mergePolledBlocks,
  type ProtocolBackend,
} from "./content-backend";
import {
  type DecofilePatchBody,
  type DecofileScopeParams,
  decofileWriteMutationKey,
  setDecofileDraft,
  throwResponseError,
} from "./decofile-api";
import type { LiveMeta } from "./resolve-schema";

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
 * Refreshes the `?__draft=` pointer for a GitHub backend: the grant comes
 * from Studio, the version is the branch head the protocol reported.
 */
async function refreshDraftPointer(
  queryClient: QueryClient,
  backend: ProtocolBackend,
  params: DecofileScopeParams,
  revision: string,
): Promise<void> {
  if (backend.source !== "github") return;
  const res = await fetch(
    `/api/${params.orgSlug}/decofile/${encodeURIComponent(params.virtualMcpId)}/${encodeURIComponent(params.branch)}/draft-grant`,
    { cache: "no-store" },
  );
  if (!res.ok) return throwResponseError(res, "Draft grant");
  const grant = (await res.json()) as { token: string; apiHost?: string };
  setDecofileDraft(queryClient, params, {
    version: revision,
    token: grant.token,
    apiHost: grant.apiHost ?? window.location.host,
  });
}

/** `blocks.list`, conditional on the revision this cache entry last saw. */
export async function readProtocolBlocks(
  queryClient: QueryClient,
  backend: ProtocolBackend,
  params: DecofileScopeParams,
  cacheKey: string,
): Promise<Record<string, unknown>> {
  const current = queryClient.getQueryData<Record<string, unknown>>(
    KEYS.decofile(cacheKey),
  );
  const revisionKey = KEYS.contentRevision(cacheKey);
  const seen = queryClient.getQueryData<string>(revisionKey);
  const result = await backend.client.blocksList(
    current && seen ? { ifNoneMatch: seen } : {},
  );
  if (result.notModified && current) return current;
  if (result.notModified) {
    // The revision outlived the map it described: read it whole.
    queryClient.removeQueries({ queryKey: revisionKey });
    return readProtocolBlocks(queryClient, backend, params, cacheKey);
  }
  queryClient.setQueryData(revisionKey, result.revision);
  await refreshDraftPointer(queryClient, backend, params, result.revision);
  return mergePolledBlocks(
    result.blocks,
    current,
    savingBlockKeys(queryClient, params),
  );
}

/** One `blocks.apply`; adopts the returned revision. */
export async function applyProtocolPatch(
  queryClient: QueryClient,
  backend: ProtocolBackend,
  params: DecofileScopeParams,
  cacheKey: string,
  patch: DecofilePatchBody,
): Promise<{ revision: string }> {
  const result = await backend.client.blocksApply({
    set: patch.set as Record<string, Record<string, unknown>> | undefined,
    delete: patch.delete,
  });
  queryClient.setQueryData(KEYS.contentRevision(cacheKey), result.revision);
  await refreshDraftPointer(queryClient, backend, params, result.revision);
  return { revision: result.revision };
}

/** `schema.get`, conditional on the version this cache entry last saw. */
export async function readProtocolMeta(
  queryClient: QueryClient,
  backend: ProtocolBackend,
  queryKey: readonly unknown[],
  versionKey: string,
): Promise<LiveMeta> {
  const current = queryClient.getQueryData<LiveMeta>(queryKey);
  const revisionKey = KEYS.contentRevision(versionKey);
  const seen = queryClient.getQueryData<string>(revisionKey);
  // The probe already read the schema once.
  if (!current && !seen && backend.schema) {
    queryClient.setQueryData(revisionKey, backend.schema.version);
    return backend.schema.schema as LiveMeta;
  }
  const result = await backend.client.schemaGet(
    current && seen ? { ifNoneMatch: seen } : {},
  );
  if (result.notModified && current) return current;
  if (result.notModified) {
    queryClient.removeQueries({ queryKey: revisionKey });
    return readProtocolMeta(queryClient, backend, queryKey, versionKey);
  }
  queryClient.setQueryData(revisionKey, result.version);
  return result.schema as LiveMeta;
}
