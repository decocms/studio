/**
 * VIRTUAL_MCP_PINNED_VIEWS_UPDATE Tool
 *
 * Update the pinned views for a virtual MCP's sidebar
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/mesh-context";
import { VirtualMCPEntitySchema } from "./schema";

const pinnedViewSchema = z.object({
  connectionId: z.string(),
  toolName: z.string(),
  label: z.string(),
  icon: z.string().nullable().optional(),
});

export const VIRTUAL_MCP_PINNED_VIEWS_UPDATE = defineTool({
  name: "VIRTUAL_MCP_PINNED_VIEWS_UPDATE" as const,
  description:
    "Update the pinned sidebar views for a virtual MCP. Replaces all current pins.",
  annotations: {
    title: "Update Pinned Views",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    virtualMcpId: z.string().describe("Virtual MCP ID"),
    pinnedViews: z
      .array(pinnedViewSchema)
      .describe("Pinned views to set for the virtual MCP sidebar"),
  }),

  outputSchema: z.object({
    item: VirtualMCPEntitySchema.nullable(),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    const { virtualMcpId, pinnedViews } = input;
    const userId = getUserId(ctx);

    const virtualMcp = await ctx.storage.virtualMcps.findById(virtualMcpId);
    if (!virtualMcp) {
      throw new Error(`Virtual MCP not found: ${virtualMcpId}`);
    }
    if (virtualMcp.organization_id !== organization.id) {
      throw new Error(`Virtual MCP not found: ${virtualMcpId}`);
    }

    const currentUI = virtualMcp.metadata?.ui ?? {
      banner: null,
      bannerColor: null,
      icon: null,
      themeColor: null,
    };

    const updatedUI = {
      ...currentUI,
      pinnedViews: pinnedViews.length > 0 ? pinnedViews : null,
    };

    const updated = await ctx.storage.virtualMcps.update(
      virtualMcpId,
      userId ?? "system",
      {
        metadata: { ...virtualMcp.metadata, ui: updatedUI },
      },
    );

    return {
      item: updated,
    };
  },
});
