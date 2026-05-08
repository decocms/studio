import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/mesh-context";
import {
  SidebarItemSchema,
  RegistryConfigSchema,
  SimpleModeConfigSchema,
  DefaultHomeAgentsConfigSchema,
} from "./schema.ts";

export const ORGANIZATION_SETTINGS_GET = defineTool({
  name: "ORGANIZATION_SETTINGS_GET",
  description:
    "Get organization-level settings including sidebar configuration, store registry settings, simple model mode, and default home agents.",
  annotations: {
    title: "Get Organization Settings",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),

  outputSchema: z.object({
    organizationId: z.string(),
    sidebar_items: z.array(SidebarItemSchema).nullable().optional(),
    enabled_plugins: z.array(z.string()).nullable().optional(),
    registry_config: RegistryConfigSchema.nullable().optional(),
    simple_mode: SimpleModeConfigSchema.nullable().optional(),
    default_home_agents: DefaultHomeAgentsConfigSchema.nullable().optional(),
    createdAt: z.string().datetime().optional().describe("ISO 8601 timestamp"),
    updatedAt: z.string().datetime().optional().describe("ISO 8601 timestamp"),
  }),

  handler: async (_, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    const settings = await ctx.storage.organizationSettings.get(organizationId);

    if (!settings) {
      return {
        organizationId,
      };
    }

    // Convert dates to ISO strings for JSON Schema compatibility
    return {
      ...settings,
      createdAt:
        settings.createdAt instanceof Date
          ? settings.createdAt.toISOString()
          : settings.createdAt,
      updatedAt:
        settings.updatedAt instanceof Date
          ? settings.updatedAt.toISOString()
          : settings.updatedAt,
    };
  },
});
