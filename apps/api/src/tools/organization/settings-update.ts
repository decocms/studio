import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import {
  SidebarItemSchema,
  RegistryConfigSchema,
  SimpleModeConfigSchema,
  DefaultHomeAgentsConfigSchema,
  OrgFlagsSchema,
} from "@decocms/shared/organization/schema";

// Bounds on client-controlled collection sizes not enforced by the shared schema.
const MAX_SIDEBAR_ITEMS = 50;
const MAX_BLOCKED_MCPS = 500;
const MAX_DEFAULT_HOME_AGENTS = 100;
const MAX_ENABLED_PLUGINS = 200;
const MAX_REGISTRIES = 200;
const MAX_STRING_LENGTH = 500;

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
    sidebar_items: z.array(SidebarItemSchema).max(MAX_SIDEBAR_ITEMS).optional(),
    enabled_plugins: z
      .array(z.string().max(MAX_STRING_LENGTH))
      .max(MAX_ENABLED_PLUGINS)
      .optional(),
    registry_config: RegistryConfigSchema.extend({
      registries: z
        .record(
          z.string().max(MAX_STRING_LENGTH),
          z.object({ enabled: z.boolean() }),
        )
        .refine((r) => Object.keys(r).length <= MAX_REGISTRIES, {
          message: `registries must have at most ${MAX_REGISTRIES} entries`,
        }),
      blockedMcps: z
        .array(z.string().max(MAX_STRING_LENGTH))
        .max(MAX_BLOCKED_MCPS),
    }).optional(),
    simple_mode: SimpleModeConfigSchema.optional(),
    default_home_agents: DefaultHomeAgentsConfigSchema.extend({
      ids: z
        .array(z.string().max(MAX_STRING_LENGTH))
        .max(MAX_DEFAULT_HOME_AGENTS),
    }).optional(),
    // .strict() here (not on the shared OrgFlagsSchema) so a mistyped flag
    // name is rejected instead of silently stripped and merged as `{}` —
    // that no-op was indistinguishable from a successful update.
    flags: OrgFlagsSchema.strict()
      .optional()
      .describe(
        "Org boolean toggles. Shallow-merged into the stored flags: keys you pass win (explicit false persists), omitted keys keep their value.",
      ),
  }),

  outputSchema: z.object({
    organizationId: z.string(),
    sidebar_items: z.array(SidebarItemSchema).nullable().optional(),
    enabled_plugins: z.array(z.string()).nullable().optional(),
    registry_config: RegistryConfigSchema.nullable().optional(),
    simple_mode: SimpleModeConfigSchema.nullable().optional(),
    default_home_agents: DefaultHomeAgentsConfigSchema.nullable().optional(),
    flags: OrgFlagsSchema.nullable().optional(),
    createdAt: z.string().datetime().describe("ISO 8601 timestamp"),
    updatedAt: z.string().datetime().describe("ISO 8601 timestamp"),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    // `requireOrganization` throws when no org is resolved on this context —
    // the previous `ctx.organization && ...` guard skipped the mismatch check
    // entirely in that case, letting `input.organizationId` (client-supplied)
    // through unvalidated instead of failing closed.
    const organization = requireOrganization(ctx);
    if (organization.id !== input.organizationId) {
      throw new Error("Cannot update settings for a different organization");
    }

    const settings = await ctx.storage.organizationSettings.upsert(
      input.organizationId,
      {
        sidebar_items: input.sidebar_items,
        enabled_plugins: input.enabled_plugins,
        registry_config: input.registry_config,
        simple_mode: input.simple_mode,
        default_home_agents: input.default_home_agents,
        flags: input.flags,
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
