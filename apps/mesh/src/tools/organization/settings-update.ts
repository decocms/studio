import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/mesh-context";
import {
  SidebarItemSchema,
  RegistryConfigSchema,
  SimpleModeConfigSchema,
  DefaultHomeAgentsConfigSchema,
  ObservationalConfigSchema,
} from "./schema.ts";

export const ORGANIZATION_SETTINGS_UPDATE = defineTool({
  name: "ORGANIZATION_SETTINGS_UPDATE",
  description:
    "Update organization-level settings such as sidebar configuration, store registry settings, simple model mode, and default home agents.",
  annotations: {
    title: "Update Organization Settings",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    organizationId: z.string(),
    sidebar_items: z.array(SidebarItemSchema).optional(),
    enabled_plugins: z.array(z.string()).optional(),
    registry_config: RegistryConfigSchema.optional(),
    simple_mode: SimpleModeConfigSchema.optional(),
    default_home_agents: DefaultHomeAgentsConfigSchema.optional(),
    observational_config: ObservationalConfigSchema.optional(),
  }),

  outputSchema: z.object({
    organizationId: z.string(),
    sidebar_items: z.array(SidebarItemSchema).nullable().optional(),
    enabled_plugins: z.array(z.string()).nullable().optional(),
    registry_config: RegistryConfigSchema.nullable().optional(),
    simple_mode: SimpleModeConfigSchema.nullable().optional(),
    default_home_agents: DefaultHomeAgentsConfigSchema.nullable().optional(),
    observational_config: ObservationalConfigSchema.nullable().optional(),
    createdAt: z.string().datetime().describe("ISO 8601 timestamp"),
    updatedAt: z.string().datetime().describe("ISO 8601 timestamp"),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    if (ctx.organization && ctx.organization.id !== input.organizationId) {
      throw new Error("Cannot update settings for a different organization");
    }

    // Forward-only: stamp `configuredAt` when the observer is (re)enabled so the
    // sweep only considers threads active at/after that instant — never the
    // org's entire pre-existing history. Server-authoritative (ignores any
    // client-sent value); preserved across edits while it stays enabled.
    let observationalConfig = input.observational_config;
    if (observationalConfig !== undefined) {
      if (observationalConfig.agentId) {
        const prev = await ctx.storage.organizationSettings.get(
          input.organizationId,
        );
        const prevConfig = prev?.observational_config;
        const configuredAt =
          prevConfig?.agentId && prevConfig.configuredAt
            ? prevConfig.configuredAt
            : new Date().toISOString();
        observationalConfig = { ...observationalConfig, configuredAt };
      } else {
        observationalConfig = { ...observationalConfig, configuredAt: null };
      }
    }

    const settings = await ctx.storage.organizationSettings.upsert(
      input.organizationId,
      {
        sidebar_items: input.sidebar_items,
        enabled_plugins: input.enabled_plugins,
        registry_config: input.registry_config,
        simple_mode: input.simple_mode,
        default_home_agents: input.default_home_agents,
        observational_config: observationalConfig,
      },
    );

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
