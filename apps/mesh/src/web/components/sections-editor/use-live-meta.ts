import { type Query, useQuery } from "@tanstack/react-query";
import { exponentialBackoffWithJitter } from "@decocms/std";
import { KEYS } from "@/web/lib/query-keys";
import { readCommittedJson } from "./read-committed-file";
import type { LiveMeta } from "./resolve-schema";

interface UseLiveMetaParams {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  previewUrl?: string | null;
}

export function useLiveMeta(
  params: UseLiveMetaParams | null,
  options?: {
    fetchEnabled?: boolean;
    refetchInterval?:
      | number
      | false
      | ((query: Query<LiveMeta>) => number | false | undefined);
  },
) {
  const fetchEnabled = options?.fetchEnabled ?? true;
  const previewUrl = params?.previewUrl;
  return useQuery({
    queryKey: params
      ? KEYS.liveMeta(
          params.orgSlug,
          params.virtualMcpId,
          params.branch,
          previewUrl ?? "",
        )
      : KEYS.liveMeta(""),
    queryFn: async () => {
      const readCommitted = () =>
        readCommittedJson<LiveMeta>(params!, ".deco/meta.gen.json");
      // Prefer the live `/live/_meta` when the dev server is up; otherwise (or on
      // failure) read the committed `.deco/meta.gen.json` snapshot so the CMS
      // schema is available even without a working preview.
      if (fetchEnabled && previewUrl) {
        const url = new URL("/live/_meta", previewUrl).href;
        const res = await fetch(url, { cache: "no-store" }).catch(() => null);
        if (res?.ok) return (await res.json()) as LiveMeta;
        const committed = await readCommitted();
        if (committed) return committed;
        const err = new Error(
          `Failed to fetch live meta: ${res?.status ?? "network error"}`,
        );
        (err as { status?: number }).status = res?.status ?? 502;
        throw err;
      }
      const committed = await readCommitted();
      if (committed) return committed;
      const err = new Error(
        "live meta unavailable (preview down, no committed snapshot)",
      );
      (err as { status?: number }).status = 502;
      throw err;
    },
    enabled: !!params,
    refetchInterval: options?.refetchInterval,
    refetchIntervalInBackground: false,
    staleTime: 300_000,
    // 502 = preview unreachable / nothing available yet. The sandbox lifecycle
    // re-invalidates this query when the dev server comes up (see
    // sandbox-events-context), so retrying just hammers a known-down endpoint.
    retry: (failureCount, error) =>
      (error as { status?: number }).status !== 502 && failureCount < 3,
    retryDelay: (attempt) =>
      exponentialBackoffWithJitter(5000, 1000, attempt, 2, 0),
  });
}
