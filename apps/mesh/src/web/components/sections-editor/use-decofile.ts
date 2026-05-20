import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";

interface UseDecofileParams {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}

export function useDecofile(params: UseDecofileParams | null) {
  const key = params
    ? `${params.orgSlug}/${params.virtualMcpId}/${params.branch}`
    : "";
  return useQuery({
    queryKey: KEYS.decofile(key),
    queryFn: async () => {
      const search = new URLSearchParams({ path: "/.decofile" });
      const res = await fetch(
        `/api/${params!.orgSlug}/vm/${encodeURIComponent(params!.virtualMcpId)}/${encodeURIComponent(params!.branch)}/preview-fetch?${search.toString()}`,
      );
      if (!res.ok) throw new Error(`Failed to fetch decofile: ${res.status}`);
      return (await res.json()) as Record<string, unknown>;
    },
    enabled: !!params,
    staleTime: 30_000,
  });
}
