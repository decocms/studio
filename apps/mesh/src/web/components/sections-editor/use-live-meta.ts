import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";
import type { LiveMeta } from "./resolve-schema";

interface UseLiveMetaParams {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}

export function useLiveMeta(params: UseLiveMetaParams | null) {
  const key = params
    ? `${params.orgSlug}/${params.virtualMcpId}/${params.branch}`
    : "";
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
    enabled: !!params,
    staleTime: 300_000,
  });
}
