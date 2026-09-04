/**
 * Studio Organization Settings Schema
 *
 * Shared zod schemas for organization settings tools.
 * These schemas match the TypeScript interfaces defined in storage/types.ts
 */

import { z } from "zod";

// Bounds a single free-text field below, independent of the array/record size caps.
const MAX_SETTINGS_STRING_LENGTH = 500;

/**
 * Sidebar item schema - matches SidebarItem interface from storage/types.ts
 */
export const SidebarItemSchema = z.object({
  title: z.string().max(MAX_SETTINGS_STRING_LENGTH),
  url: z.string().max(MAX_SETTINGS_STRING_LENGTH),
  icon: z.string().max(MAX_SETTINGS_STRING_LENGTH),
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
    .record(
      z.string().max(MAX_SETTINGS_STRING_LENGTH),
      z.object({ enabled: z.boolean() }),
    )
    .describe(
      "Per-registry enabled/disabled state. Key is connection ID. Absent registries are treated as enabled.",
    ),
  blockedMcps: z
    .array(z.string().max(MAX_SETTINGS_STRING_LENGTH))
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
    .array(z.string().max(MAX_SETTINGS_STRING_LENGTH))
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
  reviewer_enabled: z
    .boolean()
    .optional()
    .describe(
      "Run the Reviewer on a task's pull request once it's In Review — it reviews the code with the repo's stack-appropriate skills, fixes what it finds on the PR's own branch, then exercises the change on the deploy preview and approves or hands the card to a human.",
    ),
  /** @deprecated Superseded by `reviewer_enabled` — the QA Agent and Code
   *  Reviewer are one run now. Kept readable (a `z.object` strips unknown keys)
   *  so an org that turned BOTH off keeps no automated review; see
   *  `reviewerEnabled`. Drop both keys once no org has them stored. */
  qa_agent_enabled: z
    .boolean()
    .optional()
    .describe("Deprecated: see reviewer_enabled."),
  /** @deprecated See `qa_agent_enabled`. */
  code_reviewer_enabled: z
    .boolean()
    .optional()
    .describe("Deprecated: see reviewer_enabled."),
  auto_merge: z
    .boolean()
    .optional()
    .describe(
      "When the Reviewer approves a task's pull request, merge it automatically instead of leaving the merge to a human.",
    ),
  auto_resolve_conflicts: z
    .boolean()
    .optional()
    .describe(
      "When an approved pull request can't be merged because it conflicts with its base branch, hand it back to the Super Agent to resolve the conflict (check out the branch, merge the base, push). Unset, it follows `auto_merge`; set it explicitly to run one without the other.",
    ),
  cheap_reviewer_model: z
    .boolean()
    .optional()
    .describe(
      "Run the Reviewer on a cheaper model than the Super Agent that wrote the code. On by default — turning it off trades cost for some review depth.",
    ),
  coding_agent_org_mcps: z
    .boolean()
    .optional()
    .describe(
      "Give a coding-agent run (the claude-code harness in a sandbox) every MCP connection in the org as its own MCP server, on top of the narrow task-run surface it always gets. Off by default: each connection is one more server the agent connects to at session start, and all of their tools land in its context.",
    ),
  coding_agents_claude_code: z
    .boolean()
    .optional()
    .describe(
      "Run chats on a Code Agent (an agent imported from a GitHub repo) with the claude-code harness inside its sandbox, instead of hosted Decopilot. Off by default: it changes the runtime of every such chat, and claude-code flushes whole turns rather than streaming tokens.",
    ),
  auto_assign_report_tasks_to_super_agent: z
    .boolean()
    .optional()
    .describe(
      "When a report import creates a task board item without an assignee, delegate it to the Super Agent automatically instead of leaving it unassigned.",
    ),
  hosting_enabled: z
    .boolean()
    .optional()
    .describe(
      "Per-site Hosting tab (deployments, domains, deploy outcomes). Off by default. deco.cx staff and local dev always see it; this flag is the per-client lever to open it to one external org. `HOSTING_CONTROL_PLANE_GA` opens it (and its peers) to every org at once.",
    ),
  deco_analytics_enabled: z
    .boolean()
    .optional()
    .describe(
      "Per-site Deco Analytics tab (traffic, realtime, usage & limits). Off by default. deco.cx staff and local dev always see it; this flag is the per-client lever to open it to one external org. `HOSTING_CONTROL_PLANE_GA` opens it (and its peers) to every org at once.",
    ),
  e2e_enabled: z
    .boolean()
    .optional()
    .describe(
      "Per-site E2E tab (end-to-end test runs). Off by default. deco.cx staff and local dev always see it; this flag is the per-client lever to open it to one external org. `HOSTING_CONTROL_PLANE_GA` opens it (and its peers) to every org at once.",
    ),
  monitor_enabled: z
    .boolean()
    .optional()
    .describe(
      "Per-site Monitor tab (CDN Performance + Audience from the stats-lake warehouse). Off by default. deco.cx staff and local dev always see it; this flag is the per-client lever to open it to one external org. Its own deployment-wide switch `MONITOR_GA` opens it to every org at once (independent of the control-plane trio).",
    ),
  delivery_lanes_enabled: z
    .boolean()
    .optional()
    .describe(
      "Board lanes for shipping: Approved, Merged and Post-deploy Validation sit between In Review and Done, and a merged pull request lands on Merged instead of Done. For teams whose release process continues after the merge. Off by default — with it off the board and the state machine behave exactly as if the lanes did not exist.",
    ),
  cms_auto_fresh_branch: z
    .boolean()
    .optional()
    .describe(
      "When a user opens the CMS on a branch whose last commit is older than the staleness window (2 days), move the session to a freshly minted branch cut from the default branch. The stale branch is left intact on GitHub. Off by default.",
    ),
});

export type OrgFlags = z.infer<typeof OrgFlagsSchema>;

/**
 * Flags that default ON: an unset (or NULL) value reads as enabled, and only an
 * explicit `false` disables. Every other flag defaults OFF (unset reads as
 * off). New orgs get these behaviors without opting in — a team opts OUT by
 * toggling the flag off, which persists an explicit `false`.
 *
 * The automated Reviewer lives here: it runs on a task's PR by default;
 * disabling it is the deliberate action.
 */
export const DEFAULT_ON_FLAGS: ReadonlySet<keyof OrgFlags> = new Set([
  "reviewer_enabled",
  "cheap_reviewer_model",
]);

/**
 * Resolve one org flag to its effective boolean. Honors {@link DEFAULT_ON_FLAGS}
 * — a default-on flag is enabled unless stored as exactly `false`; every other
 * flag is enabled only when stored as exactly `true`. The single reader shared
 * by the server gate (`reviewerEnabled`) and the web hook (`useOrgFlag`),
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
 * Whether an approved-but-conflicting PR is handed back to the Super Agent.
 * Not `orgFlagEnabled`: unset it INHERITS `auto_merge`, which is the behavior
 * every org on auto-merge already has — splitting the two must not silently
 * take conflict resolution away from them. An explicit value wins either way,
 * so an org can resolve conflicts without auto-merging, or vice versa.
 */
export function autoResolveConflictsEnabled(
  flags: Record<string, unknown> | null | undefined,
): boolean {
  const value = flags?.auto_resolve_conflicts;
  return typeof value === "boolean" ? value : flags?.auto_merge === true;
}

/**
 * `images` and `metadata` are caller-supplied JSON blobs with no other size
 * limit on the write path (BRAND_CONTEXT_CREATE/UPDATE pass this schema
 * straight through to storage) — an org member with ordinary brand-write
 * permission could otherwise stash an arbitrarily large payload in a brand
 * context row. Mirrors the `configuration_state`/`metadata` cap on
 * `ConnectionEntitySchema`.
 */
const MAX_BRAND_JSON_FIELD_BYTES = 256 * 1024;
const MAX_BRAND_IMAGES = 50;
const MAX_BRAND_STRING_LENGTH = 500;
const MAX_BRAND_OVERVIEW_LENGTH = 5000;

/**
 * Brand context schema - org-scoped company profile
 */
export const BrandContextSchema = z.object({
  id: z.string().describe("Brand context ID"),
  name: z.string().max(MAX_BRAND_STRING_LENGTH).describe("Company name"),
  domain: z
    .string()
    .max(MAX_BRAND_STRING_LENGTH)
    .describe("Company domain (e.g. example.com)"),
  overview: z
    .string()
    .max(MAX_BRAND_OVERVIEW_LENGTH)
    .describe("Company overview / description"),
  logo: z
    .string()
    .max(MAX_BRAND_STRING_LENGTH)
    .nullable()
    .optional()
    .describe("Logo URL"),
  favicon: z
    .string()
    .max(MAX_BRAND_STRING_LENGTH)
    .nullable()
    .optional()
    .describe("Favicon URL"),
  ogImage: z
    .string()
    .max(MAX_BRAND_STRING_LENGTH)
    .nullable()
    .optional()
    .describe("OG image URL"),
  fonts: z
    .object({
      heading: z
        .string()
        .max(MAX_BRAND_STRING_LENGTH)
        .optional()
        .describe("Font family for headings"),
      body: z
        .string()
        .max(MAX_BRAND_STRING_LENGTH)
        .optional()
        .describe("Font family for body text"),
      code: z
        .string()
        .max(MAX_BRAND_STRING_LENGTH)
        .optional()
        .describe("Font family for code / monospace"),
    })
    .nullable()
    .optional()
    .describe("Font families by semantic role"),
  colors: z
    .object({
      primary: z
        .string()
        .max(MAX_BRAND_STRING_LENGTH)
        .optional()
        .describe("Primary brand color (hex)"),
      secondary: z
        .string()
        .max(MAX_BRAND_STRING_LENGTH)
        .optional()
        .describe("Secondary brand color (hex)"),
      accent: z
        .string()
        .max(MAX_BRAND_STRING_LENGTH)
        .optional()
        .describe("Accent / highlight color (hex)"),
      background: z
        .string()
        .max(MAX_BRAND_STRING_LENGTH)
        .optional()
        .describe("Background color (hex)"),
      foreground: z
        .string()
        .max(MAX_BRAND_STRING_LENGTH)
        .optional()
        .describe("Foreground / text color (hex)"),
    })
    .nullable()
    .optional()
    .describe("Semantic color palette"),
  images: z
    .array(z.record(z.string(), z.unknown()))
    .max(MAX_BRAND_IMAGES)
    .nullable()
    .optional()
    .describe("Brand images"),
  metadata: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional()
    .refine(
      (value) =>
        value === null ||
        value === undefined ||
        JSON.stringify(value).length <= MAX_BRAND_JSON_FIELD_BYTES,
      {
        message: `metadata must serialize to at most ${MAX_BRAND_JSON_FIELD_BYTES} bytes`,
      },
    )
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
