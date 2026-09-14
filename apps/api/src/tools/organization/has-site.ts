/**
 * ORGANIZATION_HAS_SITE — does this org own a legacy deco.cx site (`org_sites`)?
 *
 * A boolean-only, member-readable companion to INFRA_BILLING_SITES_LIST: the
 * home surfaces a CMS-training card only for orgs that have a site, and every
 * member sees the home, so this can't inherit the billing tool's members:manage
 * gate. Returns just the flag — never the slugs — so it stays in basic-usage
 * without widening what a regular member can read.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";

export const ORGANIZATION_HAS_SITE = defineTool({
  name: "ORGANIZATION_HAS_SITE",
  description:
    "Whether this organization owns at least one legacy deco.cx site. Boolean only — does not expose site slugs.",
  annotations: {
    title: "Has Owned Site",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    hasSite: z.boolean(),
  }),

  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const org = requireOrganization(ctx);

    const sites = await ctx.storage.orgSites.listByOrg(org.id);
    return { hasSite: sites.length > 0 };
  },
});
