/**
 * Studio Organization Settings Schema
 *
 * Shared zod schemas for organization settings tools.
 * These schemas match the TypeScript interfaces defined in storage/types.ts
 */

import { z } from "zod";

/**
 * Sidebar item schema - matches SidebarItem interface from storage/types.ts
 */
export const SidebarItemSchema = z.object({
  title: z.string(),
  url: z.string(),
  icon: z.string(),
});

export type SidebarItem = z.infer<typeof SidebarItemSchema>;

/**
 * Registry config schema - matches RegistryConfig interface from storage/types.ts
 *
 * Controls which registries are visible in the store and which individual MCPs are blocked.
 * When null/absent, defaults to Deco Store enabled with nothing blocked.
 */
export const RegistryConfigSchema = z.object({
  registries: z
    .record(z.string(), z.object({ enabled: z.boolean() }))
    .describe(
      "Per-registry enabled/disabled state. Key is connection ID. Absent registries are treated as enabled.",
    ),
  blockedMcps: z
    .array(z.string())
    .describe("List of MCP app_name or app_id values to hide from the store."),
});

export type RegistryConfig = z.infer<typeof RegistryConfigSchema>;

const ModelSlotSchema = z
  .object({
    keyId: z.string(),
    modelId: z.string(),
    title: z.string().optional(),
  })
  .nullable();

export const SimpleModeTierSchema = z.enum([
  "fast",
  "smart",
  "thinking",
  "image",
  "web_search",
  "deep_research",
]);

export type SimpleModeTier = z.infer<typeof SimpleModeTierSchema>;

/**
 * Chat-only tier subset used by automations.
 * Automations only need to pick between the three chat tiers
 * (fast/smart/thinking) — image and web_research are not applicable.
 */
export const ChatTierSchema = z.enum(["fast", "smart", "thinking"]);

export type ChatTier = z.infer<typeof ChatTierSchema>;

export const SimpleModeConfigSchema = z.object({
  tiers: z.object({
    fast: ModelSlotSchema,
    smart: ModelSlotSchema,
    thinking: ModelSlotSchema,
    image: ModelSlotSchema,
    web_search: ModelSlotSchema,
    deep_research: ModelSlotSchema,
  }),
});

export type SimpleModeConfig = z.infer<typeof SimpleModeConfigSchema>;

/**
 * Per-user override of the org's chat tier → model mapping. Only the three
 * chat tiers are user-overridable; an absent tier means "use the org default"
 * (see `resolveTier`). Reuses the org `ModelSlot` shape so the same picker UI
 * and resolution logic apply.
 */
export const UserModelPreferencesSchema = z.object({
  tiers: z.object({
    fast: ModelSlotSchema.optional(),
    smart: ModelSlotSchema.optional(),
    thinking: ModelSlotSchema.optional(),
  }),
});

export type UserModelPreferences = z.infer<typeof UserModelPreferencesSchema>;

/**
 * Default home agents config schema - matches DefaultHomeAgentsConfig from storage/types.ts.
 *
 * Each entry is a custom virtual MCP agent id (UUID). The home view renders
 * these tiles in order, capped at the home view's display limit.
 */
export const DefaultHomeAgentsConfigSchema = z.object({
  ids: z
    .array(z.string())
    .describe(
      "Ordered list of custom virtual MCP agent ids to show on the home view.",
    ),
});

export type DefaultHomeAgentsConfig = z.infer<
  typeof DefaultHomeAgentsConfigSchema
>;

/**
 * Org-level boolean toggles, stored in the `organization_settings.flags`
 * jsonb bag. THE single source of truth: adding a flag is one line here —
 * storage, the settings tools, and the web hook all derive from this schema.
 *
 * Updates are shallow-merged server-side (omitted keys keep their stored
 * value; explicit `false` persists), so partial writes never wipe neighbors.
 *
 * Only boolean toggles belong here. Anything with its own semantics (ids,
 * structured config, values that would ever need a DB index or constraint)
 * gets its own column instead.
 */
export const OrgFlagsSchema = z.object({
  demo_mode: z
    .boolean()
    .optional()
    .describe(
      "Curated demo org: the commerce connect modal proceeds without a configured required data source.",
    ),
  reports_only: z
    .boolean()
    .optional()
    .describe(
      "Curated commerce (reports) look: hides agent navigation, the home Customize button, and the Settings/Automations tabs. Defaulted on for orgs created by commerce onboarding.",
    ),
  nav_v2: z
    .boolean()
    .optional()
    .describe(
      "First-class navigation: the sidebar lists destinations (Reports, Library, Tasks) instead of chat threads, and the thread list moves into a menu at the top of the chat panel. Always on for reports_only orgs.",
    ),
  qa_agent_enabled: z
    .boolean()
    .optional()
    .describe(
      "Run the QA Agent on a task's pull request once it's In Review — it verifies the task actually solved the problem (exercises the feature, not just the diff).",
    ),
  code_reviewer_enabled: z
    .boolean()
    .optional()
    .describe(
      "Run the Code Reviewer on a task's pull request once it's In Review — it reviews the code using the repo's stack-appropriate review skills.",
    ),
  auto_merge: z
    .boolean()
    .optional()
    .describe(
      "When every enabled reviewer (QA Agent / Code Reviewer) approves a task's pull request, merge it automatically instead of leaving the merge to a human. If the merge is blocked by a conflict with the base branch, hand the PR back to the Super Agent to resolve the conflict (check out the branch, merge the base, push) so it can then merge.",
    ),
  cheap_reviewer_model: z
    .boolean()
    .optional()
    .describe(
      "Run the QA Agent and Code Reviewer on a cheaper model than the Super Agent. A review reads a diff and reaches a verdict; it does not need the model that wrote the code. Off by default — turning it on trades some review depth for cost.",
    ),
  auto_assign_report_tasks_to_super_agent: z
    .boolean()
    .optional()
    .describe(
      "When a report import creates a task board item without an assignee, delegate it to the Super Agent automatically instead of leaving it unassigned.",
    ),
  fast_preview_coding_sessions_enabled: z
    .boolean()
    .optional()
    .describe(
      "Show the 'Start coding session' button on Fast Preview projects: creates a sandbox-backed thread (fresh branch, chat enabled) without leaving Fast Preview mode for the rest of the project.",
    ),
});

export type OrgFlags = z.infer<typeof OrgFlagsSchema>;

/**
 * Flags that default ON: an unset (or NULL) value reads as enabled, and only an
 * explicit `false` disables. Every other flag defaults OFF (unset reads as
 * off). New orgs get these behaviors without opting in — a team opts OUT by
 * toggling the flag off, which persists an explicit `false`.
 *
 * The automated reviewers live here: the QA Agent and Code Reviewer run on a
 * task's PR by default; disabling one is the deliberate action.
 */
export const DEFAULT_ON_FLAGS: ReadonlySet<keyof OrgFlags> = new Set([
  "qa_agent_enabled",
  "code_reviewer_enabled",
]);

/**
 * Resolve one org flag to its effective boolean. Honors {@link DEFAULT_ON_FLAGS}
 * — a default-on flag is enabled unless stored as exactly `false`; every other
 * flag is enabled only when stored as exactly `true`. The single reader shared
 * by the server gate (`enabledReviewerKinds`) and the web hook (`useOrgFlag`),
 * so both agree on what "unset" means.
 */
export function orgFlagEnabled(
  flags: Record<string, unknown> | null | undefined,
  flag: keyof OrgFlags,
): boolean {
  const value = flags?.[flag];
  return DEFAULT_ON_FLAGS.has(flag) ? value !== false : value === true;
}

/**
 * Brand context schema - org-scoped company profile
 */
export const BrandContextSchema = z.object({
  id: z.string().describe("Brand context ID"),
  name: z.string().describe("Company name"),
  domain: z.string().describe("Company domain (e.g. example.com)"),
  overview: z.string().describe("Company overview / description"),
  logo: z.string().nullable().optional().describe("Logo URL"),
  favicon: z.string().nullable().optional().describe("Favicon URL"),
  ogImage: z.string().nullable().optional().describe("OG image URL"),
  fonts: z
    .object({
      heading: z.string().optional().describe("Font family for headings"),
      body: z.string().optional().describe("Font family for body text"),
      code: z.string().optional().describe("Font family for code / monospace"),
    })
    .nullable()
    .optional()
    .describe("Font families by semantic role"),
  colors: z
    .object({
      primary: z.string().optional().describe("Primary brand color (hex)"),
      secondary: z.string().optional().describe("Secondary brand color (hex)"),
      accent: z.string().optional().describe("Accent / highlight color (hex)"),
      background: z.string().optional().describe("Background color (hex)"),
      foreground: z
        .string()
        .optional()
        .describe("Foreground / text color (hex)"),
    })
    .nullable()
    .optional()
    .describe("Semantic color palette"),
  images: z
    .array(z.record(z.string(), z.unknown()))
    .nullable()
    .optional()
    .describe("Brand images"),
  metadata: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional()
    .describe(
      "Extra design tokens (typography, components, spacing, layout, tone, etc.)",
    ),
  archivedAt: z
    .string()
    .nullable()
    .optional()
    .describe("Archive timestamp (null to unarchive)"),
  isDefault: z
    .boolean()
    .optional()
    .describe("Whether this is the default brand for the organization"),
});

export type BrandContextInput = z.infer<typeof BrandContextSchema>;
