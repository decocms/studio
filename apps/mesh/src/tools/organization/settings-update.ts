import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/mesh-context";
import { generatePrefixedId } from "@/shared/utils/generate-id";
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

    // Observational config is a list of observers. For each: mint a stable id if
    // missing, and stamp `configuredAt` server-side so observation is
    // forward-only — the sweep only considers threads active at/after it, never
    // the org's pre-existing history. An existing observer (matched by id) keeps
    // its original configuredAt across edits; a newly-added one is stamped now.
    // The id and configuredAt are server-authoritative (client values ignored).
    let observationalConfig = input.observational_config;
    if (observationalConfig !== undefined) {
      const prev = await ctx.storage.organizationSettings.get(
        input.organizationId,
      );
      const prevById = new Map(
        (prev?.observational_config?.observers ?? []).map((o) => [o.id, o]),
      );
      const now = new Date().toISOString();
      const seen = new Set<string>();
      const observers = observationalConfig.observers.map((o) => {
        const prevObs = o.id ? prevById.get(o.id) : undefined;
        // Keep a valid existing id; mint a new one if empty or colliding.
        let id = o.id;
        if (!id || seen.has(id)) id = generatePrefixedId("obs");
        seen.add(id);
        return { ...o, id, configuredAt: prevObs?.configuredAt ?? now };
      });
      observationalConfig = { observers };
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
