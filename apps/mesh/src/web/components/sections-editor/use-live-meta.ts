import { type Query, useQuery } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";
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
  const key = params
    ? `${params.orgSlug}/${params.virtualMcpId}/${params.branch}/${params.previewUrl ?? ""}`
    : "";
  const fetchEnabled = options?.fetchEnabled ?? true;
  const previewUrl = params?.previewUrl;
  return useQuery({
    queryKey: KEYS.liveMeta(key),
    queryFn: async () => {
      const url = new URL("/live/_meta", previewUrl!).href;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        const err = new Error(`Failed to fetch live meta: ${res.status}`);
        (err as { status?: number }).status = res.status;
        throw err;
      }
      return (await res.json()) as LiveMeta;
    },
    enabled: !!params && !!previewUrl && fetchEnabled,
    refetchInterval: options?.refetchInterval,
    refetchIntervalInBackground: false,
    staleTime: 300_000,
    // 502 = preview unreachable (sandbox starting or down). The SSE lifecycle
    // re-enables this query when the preview is back, so retrying just hammers
    // a known-down endpoint and spams 5xx logs.
    retry: (failureCount, error) =>
      (error as { status?: number }).status !== 502 && failureCount < 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
  });
}
