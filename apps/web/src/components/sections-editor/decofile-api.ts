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

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
}

export interface DecofilePatchBody {
  set?: Record<string, unknown>;
  delete?: string[];
}

export type PublishResult =
  | { result: "merged"; sha: string }
  | { result: "up-to-date" }
  | { result: "pull-request"; number: number; url: string };

function decofileCacheKey(params: DecofileScopeParams): string {
  return `${params.orgSlug}/${params.virtualMcpId}/${params.branch}`;
}

function decofileApiUrl(params: DecofileScopeParams): string {
  return `/api/${params.orgSlug}/decofile/${encodeURIComponent(params.virtualMcpId)}/${encodeURIComponent(params.branch)}`;
}

async function throwResponseError(res: Response, verb: string): Promise<never> {
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
    decofile: Record<string, unknown>;
  };
  if (body.token) {
    setDecofileDraft(queryClient, params, {
      version: body.version,
      token: body.token,
    });
  }
  return body.decofile;
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
  return (await res.json()) as DecofileDraft;
}

/** Publish = merge the branch into the default branch (PR fallback). */
export function usePublishDecofile(params: DecofileScopeParams | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<PublishResult> => {
      if (!params) throw new Error("Missing decofile scope");
      const res = await fetch(`${decofileApiUrl(params)}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!res.ok) return throwResponseError(res, "Publish");
      return (await res.json()) as PublishResult;
    },
    onSuccess: () => {
      if (!params) return;
      void queryClient.invalidateQueries({
        queryKey: KEYS.decofileStatus(decofileCacheKey(params)),
      });
    },
  });
}

export interface DecofileStatus {
  baseBranch: string;
  aheadBy: number;
  behindBy: number;
}

/** Drift vs the default branch — powers the "unpublished changes" pill. */
export function useDecofileStatus(
  params: DecofileScopeParams | null,
  options?: { enabled?: boolean },
) {
  return useQuery<DecofileStatus>({
    queryKey: KEYS.decofileStatus(params ? decofileCacheKey(params) : ""),
    enabled: !!params && (options?.enabled ?? true),
    queryFn: async () => {
      const res = await fetch(`${decofileApiUrl(params!)}/status`);
      if (!res.ok) return throwResponseError(res, "Status");
      return (await res.json()) as DecofileStatus;
    },
    staleTime: 15_000,
  });
}
