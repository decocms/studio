import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import {
  SidebarItemSchema,
  RegistryConfigSchema,
  SimpleModeConfigSchema,
  DefaultHomeAgentsConfigSchema,
  OrgFlagsSchema,
  OrgRepoFlagsSchema,
  RepoFlagsSchema,
  repoFlagsKey,
} from "@decocms/shared/organization/schema";

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
    // .strict() here (not on the shared OrgFlagsSchema) so a mistyped flag
    // name is rejected instead of silently stripped and merged as `{}` —
    // that no-op was indistinguishable from a successful update.
    flags: OrgFlagsSchema.strict()
      .optional()
      .describe(
        "Org boolean toggles. Shallow-merged into the stored flags: keys you pass win (explicit false persists), omitted keys keep their value.",
      ),
    repo_flags: z
      // Keys are validated as `owner/name` so a typo'd or bogus key can't
      // accumulate as junk in the bag (nothing ever reads it back).
      .record(
        z
          .string()
          .regex(
            /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/,
            "Repo key must be `owner/name`",
          ),
        RepoFlagsSchema.strict(),
      )
      .optional()
      .describe(
        "Per-repo overrides of the review flags, keyed by `owner/name`. Merged two levels deep: repos you omit keep their overrides, and within a repo you pass, omitted keys keep their value. Pass a flag as null to drop the override and inherit the org default.",
      ),
    main_agent_id: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Virtual MCP id the org lands on instead of the Super Agent. Pass null to clear.",
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
    repo_flags: OrgRepoFlagsSchema.nullable().optional(),
    main_agent_id: z.string().nullable().optional(),
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

    // Stored lowercased so a task's `owner/name` matches however it was cased.
    const repoFlags = input.repo_flags
      ? Object.fromEntries(
          Object.entries(input.repo_flags).map(([repo, flags]) => [
            repoFlagsKey(repo) ?? repo,
            flags,
          ]),
        )
      : undefined;

    const settings = await ctx.storage.organizationSettings.upsert(
      input.organizationId,
      {
        sidebar_items: input.sidebar_items,
        enabled_plugins: input.enabled_plugins,
        registry_config: input.registry_config,
        simple_mode: input.simple_mode,
        default_home_agents: input.default_home_agents,
        flags: input.flags,
        repo_flags: repoFlags,
        main_agent_id: input.main_agent_id,
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
