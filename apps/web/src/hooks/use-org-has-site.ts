/**
 * Whether the current org owns a legacy deco.cx site (`org_sites`).
 *
 * Backed by ORGANIZATION_HAS_SITE — a boolean-only, basic-usage read, so every
 * member gets a truthful answer (unlike INFRA_BILLING_SITES_LIST, which is
 * members:manage-gated and returns empty for regular members).
 */

import { useQuery } from "@tanstack/react-query";
import { useProjectContext } from "@/sdk";
import { useStudioTools } from "@/lib/studio-tools";
import { KEYS } from "@/lib/query-keys";

export function useOrgHasSite() {
  const { org } = useProjectContext();
  const studio = useStudioTools();

  const { data } = useQuery({
    queryKey: KEYS.orgHasSite(org.id),
    // Ownership changes only on a site import — no need to refetch per nav.
    staleTime: 5 * 60_000,
    enabled: !!org.id,
    queryFn: () => studio.call("ORGANIZATION_HAS_SITE", {}),
  });

  return { hasSite: data?.hasSite ?? false };
}
