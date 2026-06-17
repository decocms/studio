import { useQuery } from "@tanstack/react-query";
import type { Capability } from "@/links/protocol";
import { useProjectContext } from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";
import { useStudioTools } from "@/web/lib/studio-tools";

export interface CurrentLink {
  online: boolean;
  machineId?: string;
  hostname?: string;
  cliVersion?: string;
  capabilities: Capability[];
  /**
   * False until LINK_CURRENT_GET has resolved at least once this mount.
   * Lets "the desktop is offline" surfaces (banner, teaser rows) hold back
   * instead of flashing offline-state UI during the initial fetch.
   */
  ready: boolean;
}

const OFFLINE: CurrentLink = { online: false, capabilities: [], ready: false };

export function useCurrentLink(): CurrentLink {
  const { org } = useProjectContext();
  const studio = useStudioTools();

  const { data } = useQuery<CurrentLink>({
    queryKey: KEYS.currentLink(org.id),
    queryFn: async () => {
      const link = await studio.call("LINK_CURRENT_GET", {});
      return link ? { ...link, ready: true } : { ...OFFLINE, ready: true };
    },
    staleTime: 4_000,
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
  });

  return data ?? OFFLINE;
}
