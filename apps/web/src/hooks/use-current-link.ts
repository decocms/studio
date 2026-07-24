import { useQuery } from "@tanstack/react-query";
import type { Capability } from "@decocms/sandbox/dispatch";
import { useProjectContext } from "@/sdk";
import { useStudioTools } from "@/lib/studio-tools";
import { KEYS } from "@/lib/query-keys";

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

export interface UseCurrentLinkOptions {
  /**
   * Poll faster while something is actively watching for a state change
   * (e.g. the "waiting for desktop" connect dialog). Everyone else gets the
   * slow, passive-display cadence.
   */
  fast?: boolean;
}

export function useCurrentLink(options?: UseCurrentLinkOptions): CurrentLink {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const fast = options?.fast ?? false;

  const { data } = useQuery<CurrentLink>({
    queryKey: KEYS.currentLink(org.id),
    queryFn: async () => {
      const link = (await studio.call("LINK_CURRENT_GET", {})) as Omit<
        CurrentLink,
        "ready"
      > | null;
      return link ? { ...link, ready: true } : { ...OFFLINE, ready: true };
    },
    staleTime: fast ? 1_000 : 10_000,
    refetchInterval: fast ? 2_000 : 15_000,
    refetchOnWindowFocus: true,
  });

  return data ?? OFFLINE;
}
