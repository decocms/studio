import { useQuery } from "@tanstack/react-query";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { matchSiteSlugConfig } from "@/components/file-picker/match-site-slug-config";
import { useFileConfigsQuery } from "@/hooks/use-file-configs";
import { useControlPlaneViews } from "@/hooks/use-organization-settings";
import { usePublicConfig } from "@/hooks/use-public-config";
import { KEYS } from "@/lib/query-keys";
import { blocksV8Project } from "@/hooks/use-blocks-v8-project";
import { useProjectContext } from "@/sdk";
import { resolveAgentSiteSlug } from "@decocms/shared/site-slug";
import type { ProjectNativeViewPresence } from "./project-sidebar-views";

export interface ProjectNativeViewPresenceResult {
  presence: ProjectNativeViewPresence;
  assetsPending: boolean;
  siteAccessPending: boolean;
}

/**
 * Resolve the native per-project views once for every surface that needs
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
  // The hosted Deco CMS: Blocks v8 projects (their switch). A v7 project
  // never gets Releases nor Calendar.
  const v8 = blocksV8Project(project);
  const siteSlug = resolveAgentSiteSlug(project);
  const hostingEnabled = config.hostingEnabled === true;
  const siteAccessProbeEnabled = hostingEnabled && !!siteSlug;

  const siteAccess = useSiteAccess(org.slug, siteSlug, siteAccessProbeEnabled);
  const ownsSite = siteAccess.data?.owned === true;
  return {
    presence: {
      assets: !!matchSiteSlugConfig(fileConfigs.data?.configs ?? [], siteSlug),
      releases: v8 && !!project?.metadata?.siteSlug,
      hosting: hostingEnabled && ownsSite && controlPlaneViews.hosting,
      e2e: hostingEnabled && ownsSite && controlPlaneViews.e2e,
      // Every v8 site: its campaigns are content its editors own.
      calendar: v8,
    },
    assetsPending: !!siteSlug && fileConfigs.isPending,
    // A disabled TanStack query is still pending; it is only unresolved when a
    // probe can actually run.
    siteAccessPending: siteAccessProbeEnabled && siteAccess.isPending,
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
