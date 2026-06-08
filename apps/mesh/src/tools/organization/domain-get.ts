/**
 * ORGANIZATION_DOMAIN_GET Tool
 *
 * Get the domain claim for an organization
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";

export const ORGANIZATION_DOMAIN_GET = defineTool({
  name: "ORGANIZATION_DOMAIN_GET",
  description: "Get the claimed email domain for an organization.",
  annotations: {
    title: "Get Organization Domain",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    domain: z.string().nullable(),
    autoJoinEnabled: z.boolean(),
  }),

  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const org = requireOrganization(ctx);
    const record = await ctx.storage.organizationDomains.getByOrganizationId(
      org.id,
    );

    return {
      domain: record?.domain ?? null,
      autoJoinEnabled: record?.autoJoinEnabled ?? false,
    };
  },
});
