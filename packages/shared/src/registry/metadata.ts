/**
 * Canonical Studio metadata carried in MCP `_meta` objects.
 *
 * `mcp.mesh` is retained as a read/write compatibility alias while existing
 * registry records and third-party MCP servers migrate to `mcp.studio`.
 */
export const STUDIO_MCP_META_KEY = "mcp.studio";
export const LEGACY_MESH_MCP_META_KEY = "mcp.mesh";

export interface StudioMcpMetadata {
  id?: string;
  verified?: boolean;
  official?: boolean;
  public_tool?: boolean | string;
  scopeName?: string;
  appName?: string;
  publishedAt?: string;
  updatedAt?: string;
  friendly_name?: string | null;
  friendlyName?: string | null;
  short_description?: string | null;
  owner?: string | null;
  readme?: string | null;
  readme_url?: string | null;
  description?: string;
  tags?: string[];
  categories?: string[];
  has_remote?: boolean;
  has_oauth?: boolean;
  oauth_config?: Record<string, unknown>;
  configuration_state?: Record<string, unknown>;
  configuration_scopes?: string[];
  tools?: Array<{
    id?: string;
    name: string;
    description?: string | null;
  }>;
  models?: unknown[];
  emails?: unknown[];
  analytics?: unknown;
  cdn?: unknown;
  [key: string]: unknown;
}

export interface StudioMcpMetadataContainer {
  "mcp.studio"?: StudioMcpMetadata;
  /** @deprecated Use `mcp.studio`. */
  "mcp.mesh"?: StudioMcpMetadata;
  [key: string]: unknown;
}

/**
 * Read Studio metadata, preferring the canonical key over the legacy alias.
 */
export function getStudioMcpMetadata(
  metadata: Record<string, unknown> | undefined,
): StudioMcpMetadata | undefined {
  const canonical = metadata?.[STUDIO_MCP_META_KEY];
  if (canonical && typeof canonical === "object" && !Array.isArray(canonical)) {
    return canonical as StudioMcpMetadata;
  }

  const legacy = metadata?.[LEGACY_MESH_MCP_META_KEY];
  if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
    return legacy as StudioMcpMetadata;
  }

  return undefined;
}

/**
 * Return metadata containing both the canonical key and its compatibility
 * alias. Dual writes keep older Studio releases and external consumers working
 * during the migration window.
 */
export function withStudioMcpMetadata(
  metadata: Record<string, unknown> | undefined,
  studioMetadata: StudioMcpMetadata,
): StudioMcpMetadataContainer {
  return {
    ...metadata,
    [STUDIO_MCP_META_KEY]: studioMetadata,
    [LEGACY_MESH_MCP_META_KEY]: studioMetadata,
  };
}
