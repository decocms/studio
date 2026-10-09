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

export const ModelSlotSchema = z
  .object({
    keyId: z.string().max(MAX_SETTINGS_STRING_LENGTH),
    modelId: z.string().max(MAX_SETTINGS_STRING_LENGTH),
    title: z.string().max(MAX_SETTINGS_STRING_LENGTH).optional(),
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

/** Cap on git credentials per organization. */
export const GIT_CREDENTIALS_MAX = 50;

/**
 * A bare git hostname with an optional port (e.g. "github.com",
 * "gitlab.example.com:8443"). Single source of truth for the shape: the schema
 * below enforces it, and both the settings UI and the daemon import it.
 */
export const SUBMODULE_HOST_RE = /^[a-zA-Z0-9.-]+(?::[0-9]+)?$/;

/**
 * One of the organization's git credentials, for repositories the clone's own
 * per-repo GitHub App token cannot reach — a submodule or a private `git:`
 * package dependency in another repository or org. The user supplies a PAT
 * (stored as a vault secret) keyed by the remote's host. Studio resolves
 * `secretId` against the credential vault on every SANDBOX_START and posts the
 * token to the daemon on a git-only channel (never the env bag); the daemon
 * installs it in the sandbox's git config, so `git submodule update` AND the
 * git a package manager spawns (`flutter pub get`, `go mod download`, npm,
 * cargo) both authenticate. `host` is the bare hostname (e.g. "github.com");
 * `git@<host>:` SSH URLs are rewritten to HTTPS so the token applies.
 *
 * Org-level, not per-agent: a host's PAT resolves the same dependency for
 * every repo in the org, and a task-board run's sandbox belongs to Decopilot,
 * which has no agent metadata to read one from (see migration 222).
 *
 * Kept named `submoduleCredentials` on the wire — that is the daemon's field.
 */
export const SubmoduleCredentialSchema = z.object({
  host: z
    .string()
    .min(1)
    .max(MAX_SETTINGS_STRING_LENGTH)
    .regex(SUBMODULE_HOST_RE)
    .describe("Git host, e.g. 'github.com' (bare hostname, no scheme)."),
  secretId: z
    .string()
    .min(1)
    .max(MAX_SETTINGS_STRING_LENGTH)
    .describe(
      "Vault secret id holding the PAT used to authenticate this host.",
    ),
});

export type SubmoduleCredential = z.infer<typeof SubmoduleCredentialSchema>;

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
  voice_mode: z.boolean().optional(),
  home_task_intake_enabled: z
    .boolean()
    .optional()
    .describe(
      "Show Task mode on the Home composer and allow reports to start tasks.",
    ),
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
      "Curated Deco Score look: hides agent navigation, the home Customize button, and the Settings/Automations tabs. Defaulted on for orgs created by commerce onboarding.",
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
      "Give a coding-agent run (the claude-code harness in a sandbox) every MCP connection in the org as its own MCP server, on top of the narrow Studio surface it always gets. Off by default: each connection is one more server the agent connects to at session start, and all of their tools land in its context.",
    ),
  coding_agents_claude_code: z
    .boolean()
    .optional()
    .describe(
      "Run chats on a Code Agent (an agent imported from a GitHub repo) with the claude-code harness inside its sandbox, instead of hosted Decopilot. Off by default: it changes the runtime of every such chat, and claude-code flushes whole turns rather than streaming tokens.",
    ),
  chat_harness_sandbox_only: z
    .boolean()
    .optional()
    .describe(
      "Run every chat with the claude-code harness in its own sandbox instead of hosted Decopilot. On by default (see DEFAULT_ON_FLAGS); a deployment without hosted sandboxes keeps Decopilot regardless.",
    ),
  auto_assign_report_tasks_to_super_agent: z
    .boolean()
    .optional()
    .describe(
      "When a Deco Score import creates a task board item without an assignee, delegate it to the Super Agent automatically instead of leaving it unassigned.",
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
  experiments_enabled: z
    .boolean()
    .optional()
    .describe(
      "Per-site Experiments tab (A/B tests + variant results). Off by default. deco.cx staff and local dev always see it; this flag is the per-client lever to open it to one external org.",
    ),
  monitor_enabled: z
    .boolean()
    .optional()
    .describe(
      "Per-site Monitor tab (CDN Performance + Audience from the stats-lake warehouse). Off by default. deco.cx staff and local dev always see it; this flag is the per-client lever to open it to one external org. Its own deployment-wide switch `MONITOR_GA` opens it to every org at once (independent of the control-plane trio).",
    ),
  site_create_enabled: z
    .boolean()
    .optional()
    .describe(
      'The "Create a new site" option under New project: generates a GitHub repository from a site template in an account the org connected, and opens it as a project. Off by default, for every org — deco.cx staff included.',
    ),
  delivery_lanes_enabled: z
    .boolean()
    .optional()
    .describe(
      "Board lanes for shipping: Approved, Merged and Post-deploy Validation sit between In Review and Done, and a merged pull request lands on Merged instead of Done. For teams whose release process continues after the merge. Off by default — with it off the board and the state machine behave exactly as if the lanes did not exist.",
    ),
  new_blocks_editor: z
    .boolean()
    .optional()
    .describe(
      "Use the redesigned blocks editor for every member of the organization. Off by default — the classic editor stays until an admin opts the org in.",
    ),
  hide_default_blog_blocks: z
    .boolean()
    .optional()
    .describe(
      "Hide the `deco-cms/blog` built-in post blocks everywhere a post is written — the inserter, the format briefs, and generated drafts — so only the site's own `site/sections/Blog/Post/*` blocks are eligible. Off by default. Blocks already present in a post keep rendering; this only governs what can be added.",
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
  "chat_harness_sandbox_only",
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
