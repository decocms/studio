/**
 * ORGANIZATION_DELETE Tool
 *
 * Soft-deletes an organization by flagging it as archived in metadata.
 * Archived organizations are invisible to all API and UI surfaces.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/mesh-context";

export const ORGANIZATION_DELETE = defineTool({
  name: "ORGANIZATION_DELETE",
  description: "Archive an organization (soft delete).",
  annotations: {
    title: "Delete Organization",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    id: z.string(),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    id: z.string(),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    await ctx.boundAuth.organization.update({
      organizationId: input.id,
      data: {
        metadata: {
          archived: true,
          archivedAt: new Date().toISOString(),
        },
      },
    });

    return {
      success: true,
      id: input.id,
    };
  },
});
