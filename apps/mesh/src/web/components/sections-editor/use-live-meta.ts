import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";
import type { LiveMeta } from "./resolve-schema";

export function useLiveMeta(previewUrl: string | null) {
  return useQuery({
    queryKey: KEYS.liveMeta(previewUrl ?? ""),
    queryFn: async () => {
      const res = await fetch(`${previewUrl}/live/_meta`);
      if (!res.ok) throw new Error(`Failed to fetch live meta: ${res.status}`);
      return (await res.json()) as LiveMeta;
    },
    enabled: !!previewUrl,
    staleTime: 300_000,
  });
}
