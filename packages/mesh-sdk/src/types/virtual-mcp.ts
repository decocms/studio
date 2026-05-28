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
 * Virtual MCP slot schema — a typed dependency declared without binding to a
 * specific connection. Resolved at runtime to the caller's user-private
 * connection of the matching app_id (falling back to an org-shared one).
 *
 * Slot uniqueness within a single agent is enforced by a partial unique index
 * on (parent_connection_id, slot_app_id) WHERE slot_app_id IS NOT NULL.
 */
const VirtualMCPSlotSchema = z.object({
  slot_app_id: z
    .string()
    .describe("app_id this slot is typed by (e.g. 'mcp-github')"),
  selected_tools: z
    .array(z.string())
    .nullable()
    .describe(
      "Selected tool names. null = all tools, array = only these tools",
    ),
  selected_resources: z
    .array(z.string())
    .nullable()
    .describe(
      "Selected resource URIs or patterns. null = all, array = only these",
    ),
  selected_prompts: z
    .array(z.string())
    .nullable()
    .describe(
      "Selected prompt names. null = all prompts, array = only these prompts",
    ),
});

export type VirtualMCPSlot = z.infer<typeof VirtualMCPSlotSchema>;

const VirtualMCPSlotInputSchema = VirtualMCPSlotSchema.extend({
  selected_tools: VirtualMCPSlotSchema.shape.selected_tools.optional(),
  selected_resources: VirtualMCPSlotSchema.shape.selected_resources.optional(),
  selected_prompts: VirtualMCPSlotSchema.shape.selected_prompts.optional(),
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
   * When true, the chat panel is open alongside the main view on first
   * load. Ignored when `defaultMainView.type === "chat"` (chat is always
   * open in that case). Absent / null / false → chat is closed unless the
   * default view is chat.
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
  homeTile: VirtualMcpHomeTileSchema.nullable().optional(),
});

export type VirtualMcpUI = z.infer<typeof VirtualMcpUISchema>;

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

/**
 * A single sandbox record in the per-(user, branch, kind) sandbox map — the
 * provider-issued handle plus the preview URL the UI renders.
 *
 * `sandboxProviderKind` lets the UI construct daemon URLs correctly:
 *  - local-docker: daemon is reached via the mesh proxy at `/api/sandbox/<sandboxHandle>/_daemon/*`
 *  - cluster: daemon is reached via the mesh proxy (same transport as local-docker);
 *    preview URL is the per-claim HTTPRoute host (in-cluster) or a local port-forward (kind dev).
 *  - user-desktop: daemon is reached directly via the user's link binary.
 *
 * `previewUrl` is nullable: blank / tool sandboxes (no `workload`, no dev
 * server) have nothing to render. UI code MUST check before constructing
 * an iframe URL.
 */
export const SandboxRecordSchema = z.object({
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
      "Daemon's public URL — what cluster→daemon RPCs target. Equal to previewUrl for user-desktop; null/absent for providers that route through cluster ingress (local-docker, cluster).",
    ),
  sandboxProviderKind: z
    // Canonical set. Migration 091 rewrote every persisted legacy value
    // ("docker", "agent-sandbox", "desktop", "remote-user", "host",
    // "freestyle") to one of these three; readers no longer accept the
    // legacy strings — Zod will reject them at parse time.
    .enum(["local-docker", "cluster", "user-desktop"])
    .optional(),
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
});

export type SandboxRecord = z.infer<typeof SandboxRecordSchema>;

/**
 * Strict parser for a single sandbox record. Migration 091 rewrote every
 * persisted legacy value (`runnerKind`, `vmId`, legacy kind names), so
 * readers no longer accept those shapes — Zod throws on any leftover.
 */
export function parseSandboxRecord(raw: unknown): SandboxRecord {
  return SandboxRecordSchema.parse(raw);
}

/** The active sandbox provider kinds. */
export type SandboxProviderKind = "local-docker" | "cluster" | "user-desktop";

/**
 * Parse a `sandboxMap[user][branch]` cell into the kind-keyed v2 shape.
 *
 * Migration 087 rewrote every cell to the 3-level layout
 * (`sandboxProviderKind → SandboxRecord`) and migration 091 rewrote every
 * legacy kind value; this reader is now strict — entries that fail to parse
 * (e.g. a stray cell missing required fields) are skipped, but no legacy
 * key/value normalization happens.
 */
export function parseBranchMap(
  raw: unknown,
): Partial<Record<SandboxProviderKind, SandboxRecord>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;

  const out: Partial<Record<SandboxProviderKind, SandboxRecord>> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!v || typeof v !== "object") continue;
    if (k !== "local-docker" && k !== "cluster" && k !== "user-desktop") {
      continue;
    }
    try {
      out[k] = SandboxRecordSchema.parse(v);
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
 * Cloud and local sandboxes can coexist on the same branch as siblings.
 *
 * The schema is strict v2. Strict input/output types here are load-bearing
 * for `useForm<…>(zodResolver(…))` callers, whose generic depends on
 * `z.input` being identical to `z.output`. A `z.preprocess` here widens
 * `z.input` to `unknown` and breaks the form.
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
    })
    .loose()
    .describe("Metadata"),
  // Nested connections
  connections: z
    .array(VirtualMCPConnectionSchema)
    .describe("Connections with their selected tools, resources, and prompts"),
  slots: z
    .array(VirtualMCPSlotSchema)
    .default([])
    .describe(
      "Typed slots — resolved to the caller's connection of the matching app_id at runtime.",
    ),
});

/**
 * The virtual MCP entity type
 */
export type VirtualMCPEntity = z.infer<typeof VirtualMCPEntitySchema>;

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
  slots: z
    .array(VirtualMCPSlotInputSchema)
    .optional()
    .describe("Typed slots to declare on the new agent."),
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
    })
    .loose()
    .nullable()
    .optional()
    .describe("Additional metadata including MCP server instructions"),
  connections: z
    .array(VirtualMCPConnectionInputSchema)
    .optional()
    .describe("New connections (replaces existing)"),
  slots: z
    .array(VirtualMCPSlotInputSchema)
    .optional()
    .describe("New slots (replaces existing slots if provided)."),
});

export type VirtualMCPUpdateData = z.infer<typeof VirtualMCPUpdateDataSchema>;
