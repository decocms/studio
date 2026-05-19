import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";

export function useDecofile(previewUrl: string | null) {
  return useQuery({
    queryKey: KEYS.decofile(previewUrl ?? ""),
    queryFn: async () => {
      const res = await fetch(`${previewUrl}/.decofile`);
      if (!res.ok) throw new Error(`Failed to fetch decofile: ${res.status}`);
      return (await res.json()) as Record<string, unknown>;
    },
    enabled: !!previewUrl,
    staleTime: 30_000,
  });
}
