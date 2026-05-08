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
 * Virtual MCP UI customization schema
 */
const VirtualMcpUISchema = z.object({
  banner: z.string().nullable().optional(),
  bannerColor: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  themeColor: z.string().nullable().optional(),
  pinnedViews: z.array(VirtualMcpPinnedViewSchema).nullable().optional(),
  layout: VirtualMcpUILayoutSchema.nullable().optional(),
});

export type VirtualMcpUI = z.infer<typeof VirtualMcpUISchema>;

/**
 * GitHub repository linked to a virtual MCP
 */
const GithubRepoSchema = z.object({
  url: z.string().describe("GitHub repository URL"),
  owner: z.string().describe("Repository owner"),
  name: z.string().describe("Repository name"),
  installationId: z.number().describe("GitHub App installation ID"),
  connectionId: z
    .string()
    .optional()
    .describe("ID of the mcp-github connection used for authentication"),
});

export type GithubRepo = z.infer<typeof GithubRepoSchema>;

/**
 * A single vm entry in vmMap — the vmId plus the preview URL the UI renders.
 *
 * `runnerKind` lets the UI construct daemon URLs correctly:
 *  - docker: daemon is reached via the mesh proxy at `/api/sandbox/<vmId>/_daemon/*`
 *  - freestyle: daemon lives at `${previewUrl}/_decopilot_vm/*` on the VM domain
 *  - agent-sandbox: daemon is reached via the mesh proxy (same transport as docker);
 *    preview URL is the per-claim HTTPRoute host (in-cluster) or a local port-forward (kind dev).
 *
 * `previewUrl` is nullable: blank / tool sandboxes (no `workload`, no dev
 * server) have nothing to render. UI code MUST check before constructing
 * an iframe URL.
 */
export const VmMapEntrySchema = z.object({
  vmId: z
    .string()
    .describe("Runner-specific handle (Freestyle VM id or docker handle)"),
  previewUrl: z
    .string()
    .nullable()
    .describe(
      "URL where the VM's iframe-proxied UI is served, or null when the sandbox has no dev server (blank / tool sandboxes).",
    ),
  runnerKind: z
    .enum(["host", "docker", "freestyle", "agent-sandbox"])
    .optional(),
  createdAt: z
    .number()
    .optional()
    .describe(
      "Epoch ms the entry was first written by VM_START. Used by the booting overlay to show a stable elapsed timer that survives browser reloads. Optional for backward compatibility with entries written before this field existed.",
    ),
});

export type VmMapEntry = z.infer<typeof VmMapEntrySchema>;

/**
 * Maps a user to their vm entries per branch.
 * Lookup: vmMap[userId][branch] -> { vmId, previewUrl }
 * Multiple threads with the same (userId, branch) share one vm.
 */
export const VmMapSchema = z.record(
  z.string().describe("userId"),
  z.record(z.string().describe("branch"), VmMapEntrySchema),
);

export type VmMap = z.infer<typeof VmMapSchema>;

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
      vmMap: VmMapSchema.optional().describe(
        "Per-user, per-branch vm mapping: vmMap[userId][branch] -> { vmId, previewUrl }",
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
      vmMap: VmMapSchema.optional().describe(
        "Per-user, per-branch vm mapping: vmMap[userId][branch] -> { vmId, previewUrl }",
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
      vmMap: VmMapSchema.optional().describe(
        "Per-user, per-branch vm mapping: vmMap[userId][branch] -> { vmId, previewUrl }",
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
});

export type VirtualMCPUpdateData = z.infer<typeof VirtualMCPUpdateDataSchema>;
