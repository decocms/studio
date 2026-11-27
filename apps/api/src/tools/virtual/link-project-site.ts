import type { StudioContext } from "../../core/studio-context";
import { ensureManagedSiteFileConfig } from "../../file-storage/managed-site-config";
import {
  claimProjectSite,
  decoSiteExists,
  otherOrgNamingSlugFromDb,
  type SiteClaimOutcome,
} from "../../hosted/claim-site";

/**
 * Links the site a project names (`metadata.siteSlug`) to it in `org_sites`,
 * then gives a linked site the managed asset config the image and file fields
 * lock onto. A slug no org owns is claimed for this org first, unless another
 * org's project already names it or deco.cx has it; a reserved slug, another
 * org's, or another project's stays unlinked (see hosted/claim-site.ts).
 * Best-effort: logs and never throws.
 */
export async function linkProjectSite(
  ctx: StudioContext,
  input: {
    organizationId: string;
    projectId: string;
    metadata: Record<string, unknown> | null | undefined;
    by: string;
  },
): Promise<SiteClaimOutcome | null> {
  const site = await claimProjectSite(
    {
      orgSites: ctx.storage.orgSites,
      isDecoSite: (slug) => decoSiteExists(slug),
      otherOrgNamingSlug: otherOrgNamingSlugFromDb(ctx.db),
    },
    input,
  );
  if (site && site.status !== "refused") {
    await ensureManagedSiteFileConfig({
      fileConfigs: ctx.storage.orgFileConfigs,
      organizationId: input.organizationId,
      slug: site.slug,
      by: input.by,
    }).catch((error) =>
      console.error("hosted: managed asset config not provisioned", {
        organizationId: input.organizationId,
        projectId: input.projectId,
        slug: site.slug,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  return site;
}
