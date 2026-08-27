/**
 * Client for the sandbox-less Fast Preview decofile API
 * (`/api/:org/decofile/:virtualMcpId/:branch`). The branch head on GitHub is
 * the draft: reads return the merged decofile at head, writes land as
 * coalesced commits, publish merges into the default branch.
 *
 * Every authenticated read/write response carries `{version, token}` — the
 * head commit sha and a signed grant the production site uses to pull the
 * draft. That pair is stashed under KEYS.decofileDraft and drives the
 * `?__draft=` preview pointer (see buildFastPreviewDraftUrl), replacing the
 * sandbox SSE `decofile` event.
 */

import { useQuery } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";

export interface DecofileScopeParams {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}

export interface DecofileDraft {
  /** Branch head commit sha. */
  version: string;
  /** Signed draft grant for the unauthenticated production-site pull. */
  token: string;
  /**
   * Authority (host[:port]) the preview server should pull the draft from —
   * the API tells us where IT is reachable, because `window.location.host` is
   * the tauri-local server in the native app (session-gated, unreachable from
   * a deployed site).
   */
  apiHost: string;
}

export interface DecofilePatchBody {
  set?: Record<string, unknown>;
  delete?: string[];
}

function decofileCacheKey(params: DecofileScopeParams): string {
  return `${params.orgSlug}/${params.virtualMcpId}/${params.branch}`;
}

/**
 * Mutation key for block save/delete writes. Lets observers (the preview's
 * autosave indicator via useIsMutating) see an in-flight write without any
 * bespoke wiring — same pattern as SANDBOX_START_MUTATION_KEY.
 */
export function decofileWriteMutationKey(
  orgSlug: string,
  virtualMcpId: string,
  branch: string,
) {
  return ["decofile-write", orgSlug, virtualMcpId, branch] as const;
}

function decofileApiUrl(params: DecofileScopeParams): string {
  return `/api/${params.orgSlug}/decofile/${encodeURIComponent(params.virtualMcpId)}/${encodeURIComponent(params.branch)}`;
}

/** Shared check-and-throw for a non-ok sandbox/decofile write response. */
export async function throwResponseError(
  res: Response,
  verb: string,
): Promise<never> {
  const body = await res.json().catch(() => ({}));
  throw new Error(
    (body as { error?: string }).error ?? `${verb} failed (${res.status})`,
  );
}

export function setDecofileDraft(
  queryClient: QueryClient,
  params: DecofileScopeParams,
  draft: DecofileDraft,
): void {
  queryClient.setQueryData(KEYS.decofileDraft(decofileCacheKey(params)), draft);
}

/**
 * Subscribe to the current draft pointer. Populated imperatively by decofile
 * reads/writes — the disabled query is only a cache subscription.
 */
export function useDecofileDraft(
  params: DecofileScopeParams | null,
): DecofileDraft | null {
  const { data } = useQuery<DecofileDraft>({
    queryKey: KEYS.decofileDraft(params ? decofileCacheKey(params) : ""),
    enabled: false,
    queryFn: async () => {
      throw new Error(
        "decofileDraft is populated by reads/writes, not fetched",
      );
    },
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
  return data ?? null;
}

/** GET the merged decofile; stashes the draft pointer as a side effect. */
export async function fetchDecofile(
  queryClient: QueryClient,
  params: DecofileScopeParams,
): Promise<Record<string, unknown>> {
  const res = await fetch(decofileApiUrl(params), { cache: "no-store" });
  if (!res.ok) {
    const err = new Error(`Failed to fetch decofile: ${res.status}`);
    (err as { status?: number }).status = res.status;
    throw err;
  }
  const body = (await res.json()) as {
    version: string;
    token?: string;
    apiHost?: string;
    decofile: Record<string, unknown>;
  };
  if (body.token) {
    setDecofileDraft(queryClient, params, {
      version: body.version,
      token: body.token,
      apiHost: body.apiHost ?? window.location.host,
    });
  }
  return body.decofile;
}

/**
 * A CMS branch is stale once its last commit is older than this. Git has no
 * ref-creation time, so "last commit" doubles as "last touched" (an untouched
 * side branch keeps the base commit it was cut from — old the moment the
 * default branch advances). See {@link fetchDecofileStatus}.
 */
export const CMS_STALE_BRANCH_MS = 2 * 24 * 60 * 60 * 1000;

interface DecofileStatus {
  baseBranch: string;
  aheadBy: number;
  behindBy: number;
  /**
   * Head commit's committer date (ISO), or null when the branch is the default
   * branch or not yet materialized on GitHub — either way, never auto-switch.
   */
  lastCommitAt: string | null;
}

/**
 * Pure staleness predicate — kept side-effect-free so it unit-tests without a
 * server. `null`/unparseable `lastCommitAt` is never stale (see DecofileStatus).
 */
export function isBranchStale(
  lastCommitAt: string | null | undefined,
  now: number,
  windowMs: number = CMS_STALE_BRANCH_MS,
): boolean {
  if (!lastCommitAt) return false;
  const at = new Date(lastCommitAt).getTime();
  if (Number.isNaN(at)) return false;
  return now - at > windowMs;
}

/** GET branch drift + head-commit age; the CMS auto-fresh-branch check reads it. */
async function fetchDecofileStatus(
  params: DecofileScopeParams,
): Promise<DecofileStatus> {
  const res = await fetch(`${decofileApiUrl(params)}/status`, {
    cache: "no-store",
  });
  if (!res.ok) return throwResponseError(res, "Status");
  return (await res.json()) as DecofileStatus;
}

export function decofileStatusQueryOptions(params: DecofileScopeParams) {
  return {
    queryKey: KEYS.decofileStatus(decofileCacheKey(params)),
    queryFn: () => fetchDecofileStatus(params),
    staleTime: 30_000,
  };
}

/** PATCH blocks; resolves with the draft pointer of the carrying commit. */
export async function patchDecofile(
  params: DecofileScopeParams,
  patch: DecofilePatchBody,
): Promise<DecofileDraft> {
  const res = await fetch(decofileApiUrl(params), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) return throwResponseError(res, "Save");
  const body = (await res.json()) as Partial<DecofileDraft> &
    Pick<DecofileDraft, "version" | "token">;
  return { ...body, apiHost: body.apiHost ?? window.location.host };
}
