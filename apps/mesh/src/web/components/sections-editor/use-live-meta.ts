import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";
import type { LiveMeta } from "./resolve-schema";

interface UseLiveMetaParams {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}

export function useLiveMeta(
  params: UseLiveMetaParams | null,
  options?: { fetchEnabled?: boolean },
) {
  const key = params
    ? `${params.orgSlug}/${params.virtualMcpId}/${params.branch}`
    : "";
  const fetchEnabled = options?.fetchEnabled ?? true;
  return useQuery({
    queryKey: KEYS.liveMeta(key),
    queryFn: async () => {
      const search = new URLSearchParams({ path: "/live/_meta" });
      const res = await fetch(
        `/api/${params!.orgSlug}/sandbox/${encodeURIComponent(params!.virtualMcpId)}/${encodeURIComponent(params!.branch)}/preview-fetch?${search.toString()}`,
      );
      if (!res.ok) throw new Error(`Failed to fetch live meta: ${res.status}`);
      return (await res.json()) as LiveMeta;
    },
    enabled: !!params && fetchEnabled,
    staleTime: 300_000,
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
  });
}
