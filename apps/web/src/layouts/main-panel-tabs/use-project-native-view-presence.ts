import { useQuery } from "@tanstack/react-query";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { matchSiteSlugConfig } from "@/components/file-picker/match-site-slug-config";
import { useFileConfigsQuery } from "@/hooks/use-file-configs";
import { useControlPlaneViews } from "@/hooks/use-organization-settings";
import { usePublicConfig } from "@/hooks/use-public-config";
import { KEYS } from "@/lib/query-keys";
import { useProjectContext } from "@/sdk";
import {
  resolveAgentSiteSlug,
  resolveAnalyticsSiteSlug,
} from "@decocms/shared/site-slug";
import type { ProjectNativeViewPresence } from "./project-sidebar-views";

export interface ProjectNativeViewPresenceResult {
  presence: ProjectNativeViewPresence;
  assetsPending: boolean;
  siteAccessPending: boolean;
}

/**
 * Resolve the five native per-project views once for every surface that needs
 * them. Product rollout, deployment wiring, tenant ownership, and per-site
 * resources are presence; the Layout preference is deliberately layered on by
 * the sidebar only.
 */
export function useProjectNativeViewPresence(
  project: VirtualMCPEntity | null | undefined,
): ProjectNativeViewPresenceResult {
  const { org } = useProjectContext();
  const config = usePublicConfig();
  const controlPlaneViews = useControlPlaneViews();
  const fileConfigs = useFileConfigsQuery();
  const siteSlug = resolveAgentSiteSlug(project);
  const hostingEnabled = config.hostingEnabled === true;
  const monitorEnabled =
    config.monitorEnabled === true || config.auth.localMode === true;
  const siteAccessProbeEnabled =
    (hostingEnabled || monitorEnabled) && !!siteSlug;

  const siteAccess = useSiteAccess(org.slug, siteSlug, siteAccessProbeEnabled);
  // Monitor reads the analytics site, which a migrated project may override.
  const analyticsSlug = resolveAnalyticsSiteSlug(project);
  const analyticsProbeEnabled =
    monitorEnabled && !!analyticsSlug && analyticsSlug !== siteSlug;
  const analyticsAccess = useSiteAccess(
    org.slug,
    analyticsSlug,
    analyticsProbeEnabled,
  );

  const ownsSite = siteAccess.data?.owned === true;
  const ownsAnalyticsSite = analyticsProbeEnabled
    ? analyticsAccess.data?.owned === true
    : ownsSite;
  return {
    presence: {
      assets: !!matchSiteSlugConfig(fileConfigs.data?.configs ?? [], siteSlug),
      hosting: hostingEnabled && ownsSite && controlPlaneViews.hosting,
      e2e: hostingEnabled && ownsSite && controlPlaneViews.e2e,
      analytics: hostingEnabled && ownsSite && controlPlaneViews.analytics,
      cdn: monitorEnabled && ownsAnalyticsSite && controlPlaneViews.monitor,
      experiments: controlPlaneViews.experiments,
    },
    assetsPending: !!siteSlug && fileConfigs.isPending,
    // A disabled TanStack query is still pending; it is only unresolved when a
    // probe can actually run.
    siteAccessPending:
      (siteAccessProbeEnabled && siteAccess.isPending) ||
      (analyticsProbeEnabled && analyticsAccess.isPending),
  };
}

function useSiteAccess(
  orgSlug: string,
  siteSlug: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: KEYS.hostingAccess(orgSlug, siteSlug ?? ""),
    queryFn: async () => {
      const response = await fetch(
        `/api/${orgSlug}/hosting/${encodeURIComponent(siteSlug ?? "")}/access`,
      );
      if (!response.ok) return { owned: false, canWrite: false };
      return (await response.json()) as {
        owned: boolean;
        canWrite: boolean;
      };
    },
    enabled,
    staleTime: 60_000,
  });
}
