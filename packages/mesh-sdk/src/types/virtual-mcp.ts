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
 * the credential vault on every VM_START. The env var KEY is independent of
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
 * fields fall back to autodetect on the next VM_START.
 */
const RuntimeMetadataSchema = z.object({
  selected: z
    .string()
    .nullable()
    .optional()
    .describe(
      "User-selected package manager (npm | pnpm | yarn | bun | deno). Null/absent means autodetect on next VM_START.",
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
      "Env vars injected on every VM_START. Literal entries inline their value; secret entries store a secretId that mesh resolves via the credential vault before posting /_decopilot_vm/config.",
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
 * A single vm entry in vmMap — the vmId plus the preview URL the UI renders.
 *
 * `sandboxProviderKind` lets the UI construct daemon URLs correctly:
 *  - docker: daemon is reached via the mesh proxy at `/api/sandbox/<vmId>/_daemon/*`
 *  - agent-sandbox: daemon is reached via the mesh proxy (same transport as docker);
 *    preview URL is the per-claim HTTPRoute host (in-cluster) or a local port-forward (kind dev).
 *
 * `previewUrl` is nullable: blank / tool sandboxes (no `workload`, no dev
 * server) have nothing to render. UI code MUST check before constructing
 * an iframe URL.
 */
export const VmMapEntrySchema = z.object({
  vmId: z.string().describe("Runner-specific handle"),
  previewUrl: z
    .string()
    .nullable()
    .describe(
      "URL where the VM's iframe-proxied UI is served, or null when the sandbox has no dev server (blank / tool sandboxes).",
    ),
  sandboxUrl: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Daemon's public URL — what cluster→daemon RPCs target. Equal to previewUrl for remote-user; null/absent for runners that route through cluster ingress (docker, agent-sandbox).",
    ),
  sandboxProviderKind: z
    // Legacy values ("freestyle", "host") are tolerated on read for
    // pre-removal vmMap entries; writers use one of the active kinds.
    // The tolerant readers (parseVmMapEntry, parseBranchMap) normalize.
    .enum(["docker", "agent-sandbox", "remote-user", "freestyle", "host"])
    .optional(),
  createdAt: z
    .number()
    .optional()
    .describe(
      "Epoch ms the entry was first written by VM_START. Used by the booting overlay to show a stable elapsed timer that survives browser reloads. Optional for backward compatibility with entries written before this field existed.",
    ),
  startedWith: z
    .object({
      packageManager: z
        .string()
        .nullable()
        .optional()
        .describe("metadata.runtime.selected at the time of VM_START"),
      port: z
        .string()
        .nullable()
        .optional()
        .describe("metadata.runtime.port at the time of VM_START"),
      path: z
        .string()
        .nullable()
        .optional()
        .describe("metadata.runtime.path at the time of VM_START"),
    })
    .optional()
    .describe(
      "Snapshot of metadata.runtime fields (selected/port/path) used at VM_START. The Preview tab compares the live metadata.runtime against this to decide if a restart is required to apply changes.",
    ),
});

export type VmMapEntry = z.infer<typeof VmMapEntrySchema>;

/**
 * Tolerant reader: pre-rename rows persisted the field as `runnerKind`. Until
 * a full re-write touches every entry, this function normalizes the legacy key
 * into `sandboxProviderKind`. Writers always use the new key.
 *
 * Use this function wherever raw JSON from the database is parsed into a
 * `VmMapEntry` — never cast unknown JSON directly as `VmMapEntry`.
 *
 * TODO(2026-06-20): drop this tolerant reader once migration 080 has run
 * everywhere and a write has touched every vmMap entry. See spec
 * docs/superpowers/specs/2026-05-20-vm-as-runtime-identity-design.md.
 */
export function parseVmMapEntry(raw: unknown): VmMapEntry {
  let normalized = raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (obj.runnerKind !== undefined && obj.sandboxProviderKind === undefined) {
      const { runnerKind, ...rest } = obj;
      normalized = { ...rest, sandboxProviderKind: runnerKind };
    }
  }
  return VmMapEntrySchema.parse(normalized);
}

/** The active sandbox provider kinds (excludes legacy "freestyle", "host"). */
type SandboxProviderKind = "docker" | "agent-sandbox" | "remote-user";

/**
 * Tolerant reader at the branch-map level.
 *
 * In v2, a branch's value is itself a map of `sandboxProviderKind → VmMapEntry`
 * (so cloud + local can coexist on the same branch). Legacy v1 rows stored a
 * single `VmMapEntry` directly at the branch level. This function accepts
 * either shape and returns a normalized v2 partial record.
 *
 * TODO(2026-06-20): drop the 2-level wrap path once migration 081 has run
 * everywhere and writers have touched every entry.
 */
export function parseBranchMap(
  raw: unknown,
): Partial<Record<SandboxProviderKind, VmMapEntry>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;

  // Legacy 2-level: the value at this level is itself a VmMapEntry (has vmId).
  if (typeof obj.vmId === "string") {
    const entry = parseVmMapEntry(obj);
    // Coalesce legacy "freestyle"/"host" values to "docker" since those
    // runners no longer exist; rows from before the removal still parse.
    const raw = entry.sandboxProviderKind;
    const kind: SandboxProviderKind =
      raw === "docker" || raw === "agent-sandbox" || raw === "remote-user"
        ? raw
        : "docker";
    return { [kind]: entry };
  }

  // New 3-level: kind → entry.
  const out: Partial<Record<SandboxProviderKind, VmMapEntry>> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!v || typeof v !== "object") continue;
    try {
      out[k as SandboxProviderKind] = parseVmMapEntry(v);
    } catch {
      // Skip malformed entries rather than throw — readers are tolerant by design.
    }
  }
  return out;
}

/**
 * Maps a user to their vm entries per (branch, sandboxProviderKind).
 * Lookup: vmMap[userId][branch][sandboxProviderKind] -> VmMapEntry
 *
 * Multiple threads on the same (userId, branch, kind) share one VM.
 * Cloud and local VMs can coexist on the same branch as siblings.
 *
 * The schema is strict v2. Reads of legacy v1 data MUST be normalized via
 * `normalizeVmMap` (this file) BEFORE Zod validation — strict input/output
 * types here are load-bearing for `useForm<…>(zodResolver(…))` callers,
 * whose generic depends on `z.input` being identical to `z.output`. A
 * `z.preprocess` here widens `z.input` to `unknown` and breaks the form.
 */
export const VmMapSchema = z.record(
  z.string().describe("userId"),
  z.record(
    z.string().describe("branch"),
    z.record(z.string().describe("sandboxProviderKind"), VmMapEntrySchema),
  ),
);

export type VmMap = z.infer<typeof VmMapSchema>;

/**
 * Normalize a raw `metadata.vmMap` value into v2 shape on read. Use this in
 * storage adapters BEFORE returning data that will be Zod-validated against
 * `VirtualMCPEntitySchema` (or any schema embedding `VmMapSchema`).
 *
 * Tolerates two legacy on-disk shapes from rows written before migration
 * 082 actually rewrote them:
 *   1. v1 2-level layout:  vmMap[user][branch] = VmMapEntry
 *   2. `runnerKind` field on entries instead of `sandboxProviderKind`
 *
 * Returns `{}` for missing / malformed input rather than throwing — readers
 * should never crash on bad on-disk data; the strict schema catches any
 * residual issues at validation time.
 */
export function normalizeVmMap(raw: unknown): VmMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: VmMap = {};
  for (const [userId, userVal] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    if (!userVal || typeof userVal !== "object" || Array.isArray(userVal)) {
      continue;
    }
    const userOut: VmMap[string] = {};
    for (const [branch, branchVal] of Object.entries(
      userVal as Record<string, unknown>,
    )) {
      const normalized = parseBranchMap(branchVal);
      if (Object.keys(normalized).length > 0) {
        userOut[branch] = normalized as VmMap[string][string];
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
      runtime: RuntimeMetadataSchema.nullable()
        .optional()
        .describe(
          "User-pinned runtime config (package manager, dev port). Empty fields = autodetect.",
        ),
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
      runtime: RuntimeMetadataSchema.nullable()
        .optional()
        .describe(
          "User-pinned runtime config (package manager, dev port). Empty fields = autodetect.",
        ),
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
