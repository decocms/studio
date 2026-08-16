/**
 * Legacy deco.cx infra billing reads. `useOwnedSites` is also the gate for the
 * whole feature: an org that owns no site never sees the nav item or the page.
 */

import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useProjectContext } from "@/sdk";
import { useStudioTools } from "@/lib/studio-tools";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";

export function useOwnedSites() {
  const { org } = useProjectContext();
  const studio = useStudioTools();

  const { data, isLoading } = useQuery({
    queryKey: KEYS.infraBillingSites(org.id),
    // Ownership changes only on a site import — no need to refetch per nav.
    staleTime: 5 * 60_000,
    queryFn: () => studio.call("INFRA_BILLING_SITES_LIST", {}),
  });

  return { sites: data?.sites.map((s) => s.slug) ?? [], isLoading };
}

/** Opens the legacy team's Stripe portal in a new tab, like every other
 *  Stripe-hosted URL in the app. */
export function useInfraBillingPortal() {
  const studio = useStudioTools();
  const t = useT();

  return useMutation({
    mutationFn: (siteSlug: string) =>
      studio.call("INFRA_BILLING_PORTAL", { siteSlug }),
    onSuccess: ({ url }) => window.open(url, "_blank", "noopener,noreferrer"),
    onError: (err: Error) =>
      toast.error(
        t("settings.infraBilling.portalError", { message: err.message }),
      ),
  });
}

export function useInfraBilling(siteSlugs: string[], period: string) {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  // Sorted so the same selection in a different click order is one cache entry.
  const slugs = [...siteSlugs].sort();

  return useQuery({
    queryKey: KEYS.infraBilling(org.id, slugs.join(","), period),
    enabled: slugs.length > 0,
    staleTime: 60_000,
    queryFn: () =>
      studio.call("INFRA_BILLING_GET", { siteSlugs: slugs, period }),
  });
}
