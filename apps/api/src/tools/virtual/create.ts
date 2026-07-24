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
} from "../../core/studio-context";
import { VirtualMCPCreateDataSchema, VirtualMCPEntitySchema } from "./schema";
import { requireOrgAdminForPinnedField } from "./require-org-admin-for-pin";
import { writeAgentPrompts } from "../../file-storage/agent-prompts";
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
    "Create a Virtual MCP (agent) that aggregates tools from multiple connections into one endpoint. Pass `prompts` to seed the agent with kickstart prompts (conversation starters shown as icebreakers). Author them from the agent's role/instructions and the descriptions of the tools it will have, so the starters are coherent and immediately useful.",
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

    if (input.data.pinned === true) {
      requireOrgAdminForPinnedField(ctx);
    }

    // `prompts` is seeded to org-fs after creation, not stored on the agent row.
    const { prompts, ...createData } = input.data;

    // Create the virtual MCP (input.data is already in the correct format)
    // Note: The facade creates a VIRTUAL connection in the connections table
    // Use a random icon+color if no icon is provided
    const dataWithIcon = {
      ...createData,
      icon: createData.icon ?? pickRandomAgentIcon(),
    };

    const virtualMcp = await ctx.storage.virtualMcps.create(
      organization.id,
      userId,
      dataWithIcon,
    );

    // Seed kickstart prompts into org-fs so the agent's gateway serves them as
    // native MCP prompts (icebreakers). Best-effort: never fail agent creation
    // over a prompt write.
    if (prompts?.length && ctx.orgFs && virtualMcp.id) {
      await writeAgentPrompts(ctx.orgFs, virtualMcp.id, userId, prompts);
    }

    // Return virtual MCP entity directly (already in correct format)
    return {
      item: virtualMcp,
    };
  },
});
