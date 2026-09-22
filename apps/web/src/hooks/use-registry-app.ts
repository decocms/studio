import { useQuery } from "@tanstack/react-query";
import { useProjectContext } from "@/sdk";
import { useStudioTools } from "@/lib/studio-tools";
import { KEYS } from "@/lib/query-keys";

export function useRegistryApp(appId: string, options?: { enabled?: boolean }) {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  return useQuery({
    queryKey: KEYS.registryApp(org.id, appId),
    queryFn: () => studio.call("COLLECTION_REGISTRY_APP_GET", { name: appId }),
    select: (result) => result.item,
    enabled: options?.enabled ?? true,
    staleTime: 5 * 60_000,
  });
}
