/**
 * COLLECTION_VIRTUAL_MCP_CREATE Tool
 *
 * Create a new MCP virtual MCP (organization-scoped) with collection binding compliance.
 * Note: Virtual MCPs are stored as connections with connection_type = 'VIRTUAL',
 * so creating a Virtual MCP automatically creates the connection.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/mesh-context";
import { getBaseUrl } from "../../core/server-constants";
import {
  getWellKnownDevAssetsConnection,
  getWellKnownSelfConnection,
  WellKnownOrgMCPId,
} from "@decocms/mesh-sdk";
import {
  isDevAssetsConnection,
  usesLocalObjectStorage,
} from "../connection/dev-assets";
import { VirtualMCPCreateDataSchema, VirtualMCPEntitySchema } from "./schema";
/**
 * Random icon+color for new agents (server-side, no React deps).
 * Uses the same icon:// format as the client-side agent-icon module.
 */
const ICON_COLORS = [
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
];
const ICON_NAMES = [
  "Star01",
  "Zap",
  "Heart",
  "Globe01",
  "Compass03",
  "Lightbulb02",
  "Rocket01",
  "Flag01",
  "BookOpen01",
  "Shield01",
  "Key01",
  "Diamond01",
  "Cube01",
  "Target04",
  "Award01",
  "Briefcase01",
  "Coffee",
  "Feather",
  "Hexagon01",
  "Layers3_01",
  "Map01",
  "Palette",
  "Package",
  "Terminal",
];
function pickRandomAgentIcon(): string {
  const color = ICON_COLORS[Math.floor(Math.random() * ICON_COLORS.length)]!;
  const icon = ICON_NAMES[Math.floor(Math.random() * ICON_NAMES.length)]!;
  return `icon://${icon}?color=${color}`;
}

/**
 * Input schema for creating virtual MCPs (wrapped in data field for collection compliance)
 */
const CreateInputSchema = z.object({
  data: VirtualMCPCreateDataSchema.describe("Data for the new virtual MCP"),
});

export type CreateVirtualMCPInput = z.infer<typeof CreateInputSchema>;

/**
 * Output schema for created virtual MCP
 */
const CreateOutputSchema = z.object({
  item: VirtualMCPEntitySchema.describe("The created virtual MCP entity"),
});

export const COLLECTION_VIRTUAL_MCP_CREATE = defineTool({
  name: "COLLECTION_VIRTUAL_MCP_CREATE",
  description:
    "Create a Virtual MCP that aggregates tools from multiple connections into one endpoint.",
  annotations: {
    title: "Create Virtual MCP",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: CreateInputSchema,
  outputSchema: CreateOutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);

    await ctx.access.check();

    const userId = getUserId(ctx);
    if (!userId) {
      throw new Error("User ID required to create virtual MCP");
    }

    // Materialize well-known pseudo-connections (dev-assets, SELF) that
    // the caller may reference in `connections[]`. These are normally
    // auto-injected at list time, so they have no DB row — the FK in
    // `connection_aggregations.child_connection_id` would reject them
    // otherwise. Mirrors the on-demand creation pattern in
    // `plugin-config-update.ts`.
    const selfId = WellKnownOrgMCPId.SELF(organization.id);
    const referenced = new Set(
      (input.data.connections ?? []).map((c) => c.connection_id),
    );
    if (referenced.size > 0) {
      const baseUrl = getBaseUrl();
      const ensure = async (id: string) => {
        const existing = await ctx.storage.connections.findById(id);
        if (existing) return;

        let seed: ReturnType<typeof getWellKnownDevAssetsConnection> | null =
          null;
        if (
          isDevAssetsConnection(id, organization.id) &&
          usesLocalObjectStorage()
        ) {
          seed = getWellKnownDevAssetsConnection(baseUrl, organization.id);
        } else if (id === selfId) {
          seed = getWellKnownSelfConnection(baseUrl, organization.id);
        }
        if (!seed) return;

        await ctx.storage.connections.create({
          ...seed,
          id: seed.id!,
          organization_id: organization.id,
          created_by: userId,
        });
      };
      await Promise.all([...referenced].map(ensure));
    }

    // Create the virtual MCP (input.data is already in the correct format)
    // Note: The facade creates a VIRTUAL connection in the connections table
    // Use a random icon+color if no icon is provided
    const dataWithIcon = {
      ...input.data,
      icon: input.data.icon ?? pickRandomAgentIcon(),
    };

    const virtualMcp = await ctx.storage.virtualMcps.create(
      organization.id,
      userId,
      dataWithIcon,
    );

    // Return virtual MCP entity directly (already in correct format)
    return {
      item: virtualMcp,
    };
  },
});
