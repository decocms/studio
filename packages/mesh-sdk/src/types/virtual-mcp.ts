/**
 * Virtual MCP Entity Schema
 *
 * Single source of truth for virtual MCP types.
 * Uses snake_case field names matching the database schema directly.
 */

import { z } from "zod";

/**
 * Virtual MCP connection schema - defines which connection and tools/resources/prompts are included
 */
const VirtualMCPConnectionSchema = z.object({
  connection_id: z.string().describe("Connection ID"),
  selected_tools: z
    .array(z.string())
    .nullable()
    .describe(
      "Selected tool names. null = all tools included, array = only these tools included",
    ),
  selected_resources: z
    .array(z.string())
    .nullable()
    .describe(
      "Selected resource URIs or patterns. Supports * and ** wildcards for pattern matching. null = all resources included, array = only these resources included",
    ),
  selected_prompts: z
    .array(z.string())
    .nullable()
    .describe(
      "Selected prompt names. null = all prompts included, array = only these prompts included",
    ),
});

export type VirtualMCPConnection = z.infer<typeof VirtualMCPConnectionSchema>;

/**
 * Virtual MCP connection schema for input (Create/Update) - fields can be optional
 */
const VirtualMCPConnectionInputSchema = VirtualMCPConnectionSchema.extend({
  selected_tools: VirtualMCPConnectionSchema.shape.selected_tools.optional(),
  selected_resources:
    VirtualMCPConnectionSchema.shape.selected_resources.optional(),
  selected_prompts:
    VirtualMCPConnectionSchema.shape.selected_prompts.optional(),
});

/**
 * Pinned view schema - a tool view pinned to a virtual MCP
 */
const VirtualMcpPinnedViewSchema = z.object({
  connectionId: z.string(),
  toolName: z.string(),
  label: z.string(),
  icon: z.string().nullable().optional(),
});

export type VirtualMcpPinnedView = z.infer<typeof VirtualMcpPinnedViewSchema>;

/**
 * A single tab declared by an agent in `metadata.ui.layout.tabs`. Rendered
 * after the fixed system tabs (Instructions / Connections / Layout / Env)
 * in the unified chat layout's right panel.
 */
export const VirtualMcpUILayoutTabSchema = z.object({
  id: z.string().describe("Stable id; used as React key and ?tab= value"),
  title: z.string().describe("Tab label"),
  icon: z.string().optional().describe("Optional lucide icon name"),
  view: z.object({
    type: z.literal("ext-app"),
    appId: z.string(),
    args: z.record(z.string(), z.unknown()).optional(),
  }),
});

export type VirtualMcpUILayoutTab = z.infer<typeof VirtualMcpUILayoutTabSchema>;

/**
 * Layout-specific settings stored under `metadata.ui.layout`. Controls which
 * main view opens by default and which additional right-panel tabs are
 * permanently available for the agent.
 */
export const VirtualMcpUILayoutSchema = z.object({
  defaultMainView: z
    .object({
      type: z.string(),
      id: z.string().optional(),
      toolName: z.string().optional(),
    })
    .nullable()
    .optional(),
  /**
   * When true, Chat is selected in the side panel alongside the main view on
   * first load. Ignored when `defaultMainView.type === "chat"` (Chat is always
   * selected in that case). Absent / null / false → the side panel is closed
   * unless the default view is Chat.
   */
  chatDefaultOpen: z.boolean().nullable().optional(),
  tabs: z.array(VirtualMcpUILayoutTabSchema).optional(),
});

export type VirtualMcpUILayout = z.infer<typeof VirtualMcpUILayoutSchema>;

/**
 * Tile UI declared by a home agent. When present, the `/$org` home page
 * renders the resource as an iframe inside the agent's tile (same MCP UI
 * iframe pattern used for tool results in chat).
 *
 * The resource lives on a specific underlying connection — not the virtual
 * MCP gateway — so we store the source `connectionId` here. The host opens
 * an MCP client to that connection directly so tool calls from inside the
 * iframe hit bare tool names (the gateway would otherwise reject calls that
 * don't carry its namespace prefix).
 */
const VirtualMcpHomeTileSchema = z.object({
  /**
   * Stable identifier for this tile instance. Allows multiple tiles
   * backed by the same tool/resource with different `toolInput` to
   * coexist on the home board. Generated via `crypto.randomUUID()` at
   * pin time. Optional for backward compatibility with tiles saved
   * before this field existed.
   */
  tileId: z.string().optional(),
  /**
   * Optional for backward compatibility with tiles saved before this field
   * existed. The home API drops tiles that don't carry a connectionId (they
   * can't render correctly without it), but parsing must still succeed so
   * existing virtual MCPs don't fail output validation on COLLECTION_*_LIST.
   */
  connectionId: z
    .string()
    .optional()
    .describe(
      "Connection that owns the resource — the host opens a direct MCP client to this connection so the iframe can call tools by their bare names.",
    ),
  resourceUri: z
    .string()
    .describe(
      "ui:// resource URI exposed by `connectionId`. Read on the home page and rendered via MCPAppRenderer.",
    ),
  toolName: z
    .string()
    .optional()
    .describe(
      "Tool name — identifies which tool's inputSchema to display when editing tile props.",
    ),
  toolInput: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "User-configured input props passed to MCPAppRenderer when rendering the tile.",
    ),
  minHeight: z.number().int().positive().optional(),
  maxHeight: z.number().int().positive().optional(),
});

export type VirtualMcpHomeTile = z.infer<typeof VirtualMcpHomeTileSchema>;

/**
 * Virtual MCP UI customization schema
 */
const VirtualMcpUISchema = z.object({
  banner: z.string().nullable().optional(),
  bannerColor: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  themeColor: z.string().nullable().optional(),
  pinnedViews: z.array(VirtualMcpPinnedViewSchema).nullable().optional(),
  layout: VirtualMcpUILayoutSchema.nullable().optional(),
  /**
   * Legacy single-tile slot. Still honored by the home-next-actions
   * endpoint when `homeTiles` is empty/absent. New writes go to
   * `homeTiles` so agents can surface more than one UI on the home
   * board.
   */
  homeTile: VirtualMcpHomeTileSchema.nullable().optional(),
  /**
   * Multiple home tiles per agent. Each entry becomes its own tile on
   * the org home board, rendered via MCPAppRenderer against the
   * resource's owning connection.
   */
  homeTiles: z.array(VirtualMcpHomeTileSchema).nullable().optional(),
  /**
   * Curated list of prompt names to surface on the home board. When
   * absent / null, the BE falls back to listing every prompt the
   * agent's gateway exposes (today's behavior). An explicit empty
   * array means "no prompts" — useful for an agent that only wants to
   * surface its UI tiles.
   */
  homePrompts: z.array(z.string()).nullable().optional(),
});

export type VirtualMcpUI = z.infer<typeof VirtualMcpUISchema>;

/**
 * Canonical reader for an agent's pinned home tiles. Prefers the
 * `homeTiles` array; falls back to the legacy single `homeTile` slot so
 * agents written before the multi-tile migration still surface their
 * tile. Returning `[]` (rather than null) keeps callers branchless.
 */
export function getHomeTiles(
  ui: VirtualMcpUI | null | undefined,
): VirtualMcpHomeTile[] {
  const arr = ui?.homeTiles;
  if (Array.isArray(arr) && arr.length > 0) return arr;
  const legacy = ui?.homeTile;
  return legacy ? [legacy] : [];
}

/**
 * Shell-portable env var name: must start with a letter or underscore and
 * contain only letters, digits, and underscores. Same shape parse-dotenv
 * enforces on imports. Single source of truth — the form editor and the
 * paste flow both validate against this.
 */
export const ENV_VAR_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const envVarKey = z.string().min(1).regex(ENV_VAR_KEY_RE, {
  message:
    "Env var key must start with a letter or underscore and contain only letters, digits, and underscores.",
});

/**
 * One env var declaration on a virtual MCP. Literal values live inline in
 * metadata; secret values store a stable secretId that mesh resolves against
 * the credential vault on every SANDBOX_START. The env var KEY is independent of
 * the secret's NAME — a single secret can back multiple env keys across
 * different agents.
 */
const RuntimeEnvEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    key: envVarKey,
    kind: z.literal("literal"),
    value: z.string(),
  }),
  z.object({
    key: envVarKey,
    kind: z.literal("secret"),
    secretId: z.string().min(1),
  }),
]);

export type RuntimeEnvEntry = z.infer<typeof RuntimeEnvEntrySchema>;

/**
 * One git submodule credential on a virtual MCP. Submodules live in other
 * repositories/orgs that the main clone's per-repo GitHub App token cannot
 * reach, so the user supplies a PAT (stored as a vault secret) keyed by the
 * submodule's host. mesh resolves `secretId` against the credential vault on
 * every SANDBOX_START and posts the token to the daemon on a git-only channel
 * (never the env bag) so `git submodule update` can authenticate. `host` is the
 * bare hostname (e.g. "github.com"); the daemon rewrites `git@<host>:` SSH
 * submodule URLs to HTTPS so the token applies.
 */
/**
 * A bare submodule hostname with an optional port (e.g. "github.com",
 * "gitlab.example.com:8443"). Single source of truth for the shape: the schema
 * below enforces it, and the sandbox UI imports it. The daemon keeps its own
 * copy (it can't depend on mesh-sdk) — see `VALID_SUBMODULE_HOST` in
 * packages/sandbox/daemon/setup/clone.ts; keep the two in sync.
 */
export const SUBMODULE_HOST_RE = /^[a-zA-Z0-9.-]+(?::[0-9]+)?$/;

const SubmoduleCredentialSchema = z.object({
  host: z
    .string()
    .min(1)
    .regex(SUBMODULE_HOST_RE)
    .describe("Submodule host, e.g. 'github.com' (bare hostname, no scheme)."),
  secretId: z
    .string()
    .min(1)
    .describe("Vault secret id holding the PAT used to fetch this host."),
});

export type SubmoduleCredential = z.infer<typeof SubmoduleCredentialSchema>;

/**
 * User-pinned runtime configuration stored under `metadata.runtime`. Empty
 * fields fall back to autodetect on the next SANDBOX_START.
 */
const RuntimeMetadataSchema = z.object({
  selected: z
    .string()
    .nullable()
    .optional()
    .describe(
      "User-selected package manager (npm | pnpm | yarn | bun | deno). Null/absent means autodetect on next SANDBOX_START.",
    ),
  port: z
    .string()
    .nullable()
    .optional()
    .describe(
      "User-selected dev server port as a string (allows '' / null for unset). Null/absent means autodetect.",
    ),
  path: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Optional path (relative to repo root) to the directory containing package.json. Null/absent means repo root. Forwarded as `application.packageManager.path` to the daemon config.",
    ),
  env: z
    .array(RuntimeEnvEntrySchema)
    .nullable()
    .optional()
    .describe(
      "Env vars injected on every SANDBOX_START. Literal entries inline their value; secret entries store a secretId that mesh resolves via the credential vault before posting /_sandbox/config.",
    ),
  submoduleCredentials: z
    .array(SubmoduleCredentialSchema)
    .nullable()
    .optional()
    .describe(
      "Git submodule credentials injected on every SANDBOX_START. Each entry maps a host to a vault secret (PAT) that mesh resolves before posting /_sandbox/config; the daemon uses it to authenticate `git submodule update` for submodules on that host.",
    ),
});

export type RuntimeMetadata = z.infer<typeof RuntimeMetadataSchema>;

/**
 * GitHub repository linked to a virtual MCP
 */
const GithubRepoSchema = z.object({
  url: z.string().describe("GitHub repository URL"),
  owner: z.string().describe("Repository owner"),
  name: z.string().describe("Repository name"),
  installationId: z
    .number()
    .optional()
    .describe(
      "GitHub App installation ID. Absent when the repo was linked without a GitHub connection (public-clone mode).",
    ),
  connectionId: z
    .string()
    .optional()
    .describe(
      "ID of the mcp-github connection used for authentication. Absent for public repos cloned without credentials.",
    ),
});

export type GithubRepo = z.infer<typeof GithubRepoSchema>;

/** The active sandbox provider kinds. */
export type SandboxProviderKind = "agent-sandbox" | "user-desktop";
export type LegacySandboxProviderKind = SandboxProviderKind | "cluster";

const sandboxProviderKindSchema = z.enum(["agent-sandbox", "user-desktop"]);
const legacySandboxProviderKindSchema = z.enum([
  "agent-sandbox",
  "user-desktop",
  "cluster",
]);

export function normalizeSandboxProviderKind(
  kind: LegacySandboxProviderKind,
): SandboxProviderKind {
  return kind === "cluster" ? "agent-sandbox" : kind;
}

/**
 * A single sandbox record in the per-(user, branch, kind) sandbox map — the
 * provider-issued handle plus the preview URL the UI renders.
 *
 * `sandboxProviderKind` lets the UI construct daemon URLs correctly:
 *  - agent-sandbox: daemon is reached via the mesh proxy; preview URL is the
 *    per-claim HTTPRoute host (in-cluster) or a local port-forward (kind dev).
 *  - user-desktop: daemon is reached directly via the user's link binary.
 *
 * `previewUrl` is nullable: blank / tool sandboxes (no `workload`, no dev
 * server) have nothing to render. UI code MUST check before constructing
 * an iframe URL.
 */
const SandboxRecordShape = {
  sandboxHandle: z.string().describe("Provider-specific handle"),
  previewUrl: z
    .string()
    .nullable()
    .describe(
      "URL where the sandbox's iframe-proxied UI is served, or null when the sandbox has no dev server (blank / tool sandboxes).",
    ),
  sandboxApiUrl: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Daemon's public URL — what cluster→daemon RPCs target. Equal to previewUrl for user-desktop; null/absent for the agent-sandbox provider (routes through hosted ingress).",
    ),
  sandboxProviderKind: sandboxProviderKindSchema.optional(),
  createdAt: z
    .number()
    .optional()
    .describe(
      "Epoch ms the entry was first written by SANDBOX_START. Used by the booting overlay to show a stable elapsed timer that survives browser reloads. Optional for backward compatibility with entries written before this field existed.",
    ),
  startedWith: z
    .object({
      packageManager: z
        .string()
        .nullable()
        .optional()
        .describe("metadata.runtime.selected at the time of SANDBOX_START"),
      port: z
        .string()
        .nullable()
        .optional()
        .describe("metadata.runtime.port at the time of SANDBOX_START"),
      path: z
        .string()
        .nullable()
        .optional()
        .describe("metadata.runtime.path at the time of SANDBOX_START"),
    })
    .optional()
    .describe(
      "Snapshot of metadata.runtime fields (selected/port/path) used at SANDBOX_START. The Preview tab compares the live metadata.runtime against this to decide if a restart is required to apply changes.",
    ),
} satisfies z.ZodRawShape;

export const SandboxRecordSchema = z.object(SandboxRecordShape);

const LegacySandboxRecordSchema = z.object({
  ...SandboxRecordShape,
  sandboxProviderKind: legacySandboxProviderKindSchema.optional(),
});

export type SandboxRecord = z.infer<typeof SandboxRecordSchema>;

/**
 * Parser for a single sandbox record. The public schema stays JSON-schema-safe
 * for MCP tools/list, so legacy provider values are normalized here instead of
 * with Zod transforms.
 */
export function parseSandboxRecord(raw: unknown): SandboxRecord {
  const parsed = LegacySandboxRecordSchema.parse(raw);
  return SandboxRecordSchema.parse({
    ...parsed,
    sandboxProviderKind: parsed.sandboxProviderKind
      ? normalizeSandboxProviderKind(parsed.sandboxProviderKind)
      : undefined,
  });
}

/**
 * Parse a `sandboxMap[user][branch]` cell into the kind-keyed v2 shape.
 *
 * Migration 087 rewrote every cell to the 3-level layout
 * (`sandboxProviderKind → SandboxRecord`) and migration 091 rewrote every
 * legacy kind value; this reader remains strict about retired values, while
 * still normalizing the legacy "cluster" key/value to "agent-sandbox".
 */
export function parseBranchMap(
  raw: unknown,
): Partial<Record<SandboxProviderKind, SandboxRecord>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;

  const out: Partial<Record<SandboxProviderKind, SandboxRecord>> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!v || typeof v !== "object") continue;
    if (k !== "cluster" && k !== "agent-sandbox" && k !== "user-desktop") {
      continue;
    }
    const kind = normalizeSandboxProviderKind(k);
    try {
      if (k === "cluster" && out[kind]) {
        continue;
      }
      out[kind] = parseSandboxRecord(v);
    } catch {
      // Skip malformed entries rather than throw — readers stay forgiving
      // about unexpected shapes within a known-key cell.
    }
  }
  return out;
}

/**
 * Maps a user to their sandbox records per (branch, sandboxProviderKind).
 * Lookup: sandboxMap[userId][branch][sandboxProviderKind] -> SandboxRecord
 *
 * Multiple threads on the same (userId, branch, kind) share one sandbox.
 * Hosted and desktop sandboxes can coexist on the same branch as siblings.
 *
 * This exported schema intentionally has no transforms so it can be represented
 * in JSON Schema for MCP tools/list. Use `normalizeSandboxMap` when reading
 * persisted or legacy-shaped sandbox maps.
 */
export const SandboxMapSchema = z.record(
  z.string().describe("userId"),
  z.record(
    z.string().describe("branch"),
    z.record(z.string().describe("sandboxProviderKind"), SandboxRecordSchema),
  ),
);

export type SandboxMap = z.infer<typeof SandboxMapSchema>;

/**
 * Normalize a raw `metadata.sandboxMap` value into v2 shape on read. Use this
 * in storage adapters BEFORE returning data that will be Zod-validated against
 * `VirtualMCPEntitySchema` (or any schema embedding `SandboxMapSchema`).
 *
 * After migration 091, the stored shape is the strict 3-level
 * `userId → branch → sandboxProviderKind → SandboxRecord`. Returns `{}` for
 * missing / malformed input rather than throwing — readers stay forgiving
 * about unexpected per-row corruption; the strict schema catches any
 * residual issues at validation time.
 */
export function normalizeSandboxMap(raw: unknown): SandboxMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: SandboxMap = {};
  for (const [userId, userVal] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    if (!userVal || typeof userVal !== "object" || Array.isArray(userVal)) {
      continue;
    }
    const userOut: SandboxMap[string] = {};
    for (const [branch, branchVal] of Object.entries(
      userVal as Record<string, unknown>,
    )) {
      const normalized = parseBranchMap(branchVal);
      if (Object.keys(normalized).length > 0) {
        userOut[branch] = normalized as SandboxMap[string][string];
      }
    }
    if (Object.keys(userOut).length > 0) {
      out[userId] = userOut;
    }
  }
  return out;
}

/**
 * A file attached to an agent as reference knowledge. Stored in object
 * storage and recorded on `metadata.knowledge`. At system-prompt build time
 * the agent gets a `<knowledge>` block listing these files — small text
 * documents are inlined in full (always in context), larger or binary files
 * are listed as references the agent can retrieve on demand.
 *
 * Only the reference is stored here (not the content) so the entity payload
 * stays lean across list/get reads.
 */
const KnowledgeFileSchema = z.object({
  id: z.string().describe("Stable identifier for this knowledge file"),
  name: z.string().describe("File name shown in the UI"),
  kind: z
    .enum(["file", "skill"])
    .optional()
    .describe(
      "'file' (a single document) or 'skill' (a Claude Code skill folder containing SKILL.md). Defaults to 'file'.",
    ),
  volume: z
    .string()
    .describe("Org filesystem (Library) volume the file lives in"),
  path: z.string().describe("Path within the volume"),
  url: z
    .string()
    .describe("Same-origin URL to read the file (display/download)"),
  contentType: z
    .string()
    .nullable()
    .optional()
    .describe("MIME type, used to decide whether to inline the content"),
  size: z.number().nullable().optional().describe("File size in bytes"),
  addedAt: z.string().describe("ISO timestamp when the file was attached"),
});

export type KnowledgeFile = z.infer<typeof KnowledgeFileSchema>;

/**
 * Reusable `metadata.knowledge` field definition shared by the entity, create,
 * and update schemas so the three stay in sync.
 */
const knowledgeMetadataField = z
  .array(KnowledgeFileSchema)
  .nullable()
  .optional()
  .describe(
    "Files attached to the agent as reference knowledge. Surfaced in the system prompt: small text documents are inlined, others are listed as retrievable references.",
  );

/**
 * Controls when a code agent's changes may be published directly (squash-merged
 * to base) instead of going through pull-request review.
 * - `smart` (default): a cheap AI judges each change — code that looks risky
 *   (new endpoints, large or backend changes) needs review; content/design and
 *   small frontend edits publish directly.
 * - `code-review`: any code change requires review; only CMS/design changes
 *   publish directly.
 * - `open`: every change publishes directly, no review required.
 */
const PublishPolicySchema = z.enum(["smart", "code-review", "open"]);
export type PublishPolicy = z.infer<typeof PublishPolicySchema>;

const publishPolicyMetadataField = PublishPolicySchema.nullable()
  .optional()
  .describe(
    "Controls when this code agent's changes may be published directly vs. requiring PR review. 'smart' (default) uses AI to judge per change; 'code-review' requires review for any code; 'open' allows direct publish always.",
  );

/**
 * Virtual MCP entity schema - single source of truth
 * Compliant with collections binding pattern
 */
export const VirtualMCPEntitySchema = z.object({
  // Base collection entity fields
  id: z.string().describe("Unique identifier"),
  title: z.string().describe("Human-readable name"),
  description: z.string().nullable().describe("Description"),
  icon: z.string().nullable().describe("Icon URL"),
  created_at: z.string().describe("Creation timestamp"),
  updated_at: z.string().describe("Last update timestamp"),
  created_by: z.string().describe("User ID who created this item"),
  updated_by: z
    .string()
    .optional()
    .describe("User ID who last updated this item"),

  // Entity-specific fields
  organization_id: z.string().describe("Organization ID this item belongs to"),
  status: z.enum(["active", "inactive"]).describe("Current status"),
  pinned: z.boolean().describe("Whether this space is pinned to the sidebar"),
  // Metadata (stored in connections.metadata)
  // Normalize null/undefined to { instructions: null } for consistent form tracking
  metadata: z
    .object({
      instructions: z
        .string()
        .nullable()
        .describe("Instructions also used as system prompt"),
      enabled_plugins: z
        .array(z.string())
        .nullable()
        .optional()
        .describe("List of enabled plugin IDs"),
      subAgents: z
        .array(z.string())
        .nullable()
        .optional()
        .describe(
          "Allowlist of Virtual MCP (agent) or concrete MCP connection IDs this agent may delegate to via subtask. Concrete connections create ephemeral subagents. null/absent = all active org targets; empty array = itself only.",
        ),
      liveAgentId: z
        .string()
        .nullable()
        .optional()
        .describe(
          "ID of the live agent this (dev) agent develops. Set only on dev agents; powers the Develop/Live toggle. A dev agent is hidden from the sidebar (reached via the toggle on its live counterpart).",
        ),
      ui: VirtualMcpUISchema.nullable()
        .optional()
        .describe("UI customization settings"),
      githubRepo: GithubRepoSchema.nullable()
        .optional()
        .describe("Linked GitHub repository"),
      runtime: RuntimeMetadataSchema.nullable()
        .optional()
        .describe(
          "User-pinned runtime config (package manager, dev port). Empty fields = autodetect.",
        ),
      sandboxMap: SandboxMapSchema.optional().describe(
        "Per-user, per-branch sandbox mapping: sandboxMap[userId][branch] -> { sandboxHandle, previewUrl }",
      ),
      knowledge: knowledgeMetadataField,
      siteSlug: z
        .string()
        .nullable()
        .optional()
        .describe("Linked asset site slug (managed storage tenancy)"),
      publishPolicy: publishPolicyMetadataField,
      productionUrl: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Live production URL of the linked site (e.g. https://acme.com). Painted in the preview iframe while the sandbox dev server is waking.",
        ),
    })
    .loose()
    .describe("Metadata"),
  // Nested connections
  connections: z
    .array(VirtualMCPConnectionSchema)
    .describe("Connections with their selected tools, resources, and prompts"),
});

/**
 * The virtual MCP entity type
 */
export type VirtualMCPEntity = z.infer<typeof VirtualMCPEntitySchema>;

/**
 * A kickstart prompt seeded on an agent at creation time. Persisted to org-fs
 * (not on the agent row) and surfaced as a native MCP prompt on the agent's
 * gateway — so it shows up as an icebreaker, on the org home, and via `/`
 * mentions, exactly like a prompt exposed by a connected MCP.
 */
export const AgentKickstartPromptSchema = z.object({
  title: z.string().min(1).max(120).describe("Short label shown on the chip"),
  description: z
    .string()
    .max(280)
    .optional()
    .describe("One-line subtitle shown under the title"),
  text: z
    .string()
    .min(1)
    .describe("The message sent to the agent when the prompt is clicked"),
});

export type AgentKickstartPrompt = z.infer<typeof AgentKickstartPromptSchema>;

/**
 * Input schema for creating virtual MCPs
 */
export const VirtualMCPCreateDataSchema = z.object({
  title: z.string().min(1).max(255).describe("Name for the virtual MCP"),
  description: z
    .string()
    .nullable()
    .optional()
    .describe("Optional description"),
  icon: z.string().nullish().describe("Optional icon URL"),
  status: z
    .enum(["active", "inactive"])
    .optional()
    .default("active")
    .describe("Initial status"),
  pinned: z.boolean().optional().default(false).describe("Pin to sidebar"),
  metadata: z
    .object({
      instructions: z
        .string()
        .nullable()
        .optional()
        .describe("MCP server instructions"),
      enabled_plugins: z
        .array(z.string())
        .nullable()
        .optional()
        .describe("List of enabled plugin IDs"),
      subAgents: z
        .array(z.string())
        .nullable()
        .optional()
        .describe(
          "Allowlist of Virtual MCP (agent) or concrete MCP connection IDs this agent may delegate to via subtask. Concrete connections create ephemeral subagents. null/absent = all active org targets; empty array = itself only.",
        ),
      liveAgentId: z
        .string()
        .nullable()
        .optional()
        .describe(
          "ID of the live agent this (dev) agent develops. Set only on dev agents; powers the Develop/Live toggle. A dev agent is hidden from the sidebar (reached via the toggle on its live counterpart).",
        ),
      ui: VirtualMcpUISchema.nullable()
        .optional()
        .describe("UI customization settings"),
      githubRepo: GithubRepoSchema.nullable()
        .optional()
        .describe("Linked GitHub repository"),
      runtime: RuntimeMetadataSchema.nullable()
        .optional()
        .describe(
          "User-pinned runtime config (package manager, dev port). Empty fields = autodetect.",
        ),
      sandboxMap: SandboxMapSchema.optional().describe(
        "Per-user, per-branch sandbox mapping: sandboxMap[userId][branch] -> { sandboxHandle, previewUrl }",
      ),
      knowledge: knowledgeMetadataField,
      siteSlug: z
        .string()
        .nullable()
        .optional()
        .describe("Linked asset site slug (managed storage tenancy)"),
      publishPolicy: publishPolicyMetadataField,
      productionUrl: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Live production URL of the linked site (e.g. https://acme.com). Painted in the preview iframe while the sandbox dev server is waking.",
        ),
    })
    .loose()
    .nullable()
    .optional()
    .describe("Additional metadata including MCP server instructions"),
  connections: z
    .array(VirtualMCPConnectionInputSchema)
    .describe(
      "Connections to include/exclude (can be empty for exclusion mode)",
    ),
  prompts: z
    .array(AgentKickstartPromptSchema)
    .optional()
    .describe(
      "Optional kickstart prompts to seed on the agent. Each becomes a clickable conversation starter (icebreaker) on the agent. Author them from the agent's role and the tools it will have so they're coherent and immediately useful.",
    ),
});

export type VirtualMCPCreateData = z.infer<typeof VirtualMCPCreateDataSchema>;

/**
 * Input schema for updating virtual MCPs
 */
export const VirtualMCPUpdateDataSchema = z.object({
  title: z.string().min(1).max(255).optional().describe("New name"),
  description: z
    .string()
    .nullable()
    .optional()
    .describe("New description (null to clear)"),
  icon: z.string().nullish().describe("New icon URL"),
  status: z.enum(["active", "inactive"]).optional().describe("New status"),
  pinned: z.boolean().optional().describe("Pin/unpin from sidebar"),
  metadata: z
    .object({
      instructions: z
        .string()
        .nullable()
        .optional()
        .describe("MCP server instructions"),
      enabled_plugins: z
        .array(z.string())
        .nullable()
        .optional()
        .describe("List of enabled plugin IDs"),
      subAgents: z
        .array(z.string())
        .nullable()
        .optional()
        .describe(
          "Allowlist of Virtual MCP (agent) or concrete MCP connection IDs this agent may delegate to via subtask. Concrete connections create ephemeral subagents. null/absent = all active org targets; empty array = itself only.",
        ),
      liveAgentId: z
        .string()
        .nullable()
        .optional()
        .describe(
          "ID of the live agent this (dev) agent develops. Set only on dev agents; powers the Develop/Live toggle. A dev agent is hidden from the sidebar (reached via the toggle on its live counterpart).",
        ),
      ui: VirtualMcpUISchema.nullable()
        .optional()
        .describe("UI customization settings"),
      githubRepo: GithubRepoSchema.nullable()
        .optional()
        .describe("Linked GitHub repository"),
      runtime: RuntimeMetadataSchema.nullable()
        .optional()
        .describe(
          "User-pinned runtime config (package manager, dev port). Empty fields = autodetect.",
        ),
      sandboxMap: SandboxMapSchema.optional().describe(
        "Per-user, per-branch sandbox mapping: sandboxMap[userId][branch] -> { sandboxHandle, previewUrl }",
      ),
      knowledge: knowledgeMetadataField,
      siteSlug: z
        .string()
        .nullable()
        .optional()
        .describe("Linked asset site slug (managed storage tenancy)"),
      publishPolicy: publishPolicyMetadataField,
      productionUrl: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Live production URL of the linked site (e.g. https://acme.com). Painted in the preview iframe while the sandbox dev server is waking.",
        ),
    })
    .loose()
    .nullable()
    .optional()
    .describe("Additional metadata including MCP server instructions"),
  connections: z
    .array(VirtualMCPConnectionInputSchema)
    .optional()
    .describe("New connections (replaces existing)"),
  prompts: z
    .array(AgentKickstartPromptSchema)
    .optional()
    .describe(
      "Replace the agent's kickstart prompts with this full set. Omit to leave them unchanged; pass an empty array to remove all. Each becomes a clickable conversation starter (icebreaker).",
    ),
});

export type VirtualMCPUpdateData = z.infer<typeof VirtualMCPUpdateDataSchema>;
