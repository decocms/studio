/**
 * INFRA_BILLING_SITES_LIST — the legacy deco.cx sites this org owns, from
 * `org_sites` (Studio's tenancy source of truth). Cheap, single indexed read:
 * the settings nav calls it to decide whether to show Infra Billing at all, and
 * the page uses it to populate the site selector.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";

export const INFRA_BILLING_SITES_LIST = defineTool({
  name: "INFRA_BILLING_SITES_LIST",
  description:
    "List the legacy deco.cx site slugs this organization owns. Empty for orgs with no sites.",
  annotations: {
    title: "List Owned Sites",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    sites: z.array(z.object({ slug: z.string() })),
  }),

  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const org = requireOrganization(ctx);

    const sites = await ctx.storage.orgSites.listByOrg(org.id);
    return { sites: sites.map(({ slug }) => ({ slug })) };
  },
});
