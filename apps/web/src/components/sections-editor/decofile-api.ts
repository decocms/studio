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
