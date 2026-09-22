import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import {
  SidebarItemSchema,
  SimpleModeConfigSchema,
  DefaultHomeAgentsConfigSchema,
  GIT_CREDENTIALS_MAX,
  OrgFlagsSchema,
  SubmoduleCredentialSchema,
} from "@decocms/shared/organization/schema";

// Bounds on client-controlled collection sizes not enforced by the shared schema.
const MAX_SIDEBAR_ITEMS = 50;
const MAX_DEFAULT_HOME_AGENTS = 100;
const MAX_EXCLUDED_MCPS = 500;
const MAX_STRING_LENGTH = 500;

export const ORGANIZATION_SETTINGS_UPDATE = defineTool({
  name: "ORGANIZATION_SETTINGS_UPDATE",
  description:
    "Update organization-level settings such as sidebar configuration, simple model mode, and default home agents.",
  annotations: {
    title: "Update Organization Settings",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    organizationId: z.string().min(1, "organizationId is required"),
    sidebar_items: z.array(SidebarItemSchema).max(MAX_SIDEBAR_ITEMS).optional(),
    coding_agent_mcp_excluded: z
      .array(z.string().max(MAX_STRING_LENGTH))
      .max(MAX_EXCLUDED_MCPS)
      .optional()
      .describe(
        "Connection ids a coding-agent run must not mount, even with `coding_agent_org_mcps` on. Replaces the stored list; pass [] to clear it.",
      ),
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
    submodule_credentials: z
      .array(SubmoduleCredentialSchema)
      .max(GIT_CREDENTIALS_MAX)
      .optional()
      .describe(
        "Per-host PATs (as vault secret ids) every sandbox in the org installs in its git config. Replaces the stored list; pass [] to clear it.",
      ),
  }),

  outputSchema: z.object({
    organizationId: z.string(),
    sidebar_items: z.array(SidebarItemSchema).nullable().optional(),
    coding_agent_mcp_excluded: z.array(z.string()).nullable().optional(),
    simple_mode: SimpleModeConfigSchema.nullable().optional(),
    default_home_agents: DefaultHomeAgentsConfigSchema.nullable().optional(),
    flags: OrgFlagsSchema.nullable().optional(),
    submodule_credentials: z
      .array(SubmoduleCredentialSchema)
      .nullable()
      .optional(),
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
        coding_agent_mcp_excluded: input.coding_agent_mcp_excluded,
        simple_mode: input.simple_mode,
        default_home_agents: input.default_home_agents,
        flags: input.flags,
        submodule_credentials: input.submodule_credentials,
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
