/**
 * Registry catalog — canonical shapes.
 *
 * `CatalogItem` is the single wire shape served by the REST route and the
 * MCP shim. It mirrors the frontend `MCPRegistryServer`
 * (`web/components/store/types.ts`) so REST responses are structurally
 * compatible with what `extractConnectionData` consumes — but the server side
 * owns its own copy (no `@/web` import across the boundary).
 *
 * Both sources (the first-party `registry.json` and the community/official
 * feed) already emit this `{ server, _meta }` envelope, so normalization is
 * mostly defaulting `id`/`title`/timestamps.
 */

export interface CatalogServerIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: "light" | "dark";
}

export interface CatalogServerRemote {
  type?: string;
  url?: string;
  name?: string;
  title?: string;
  description?: string;
}

export interface CatalogServerPackage {
  identifier: string;
  name?: string;
  version?: string;
  transport?: { type: "stdio" | "http" | "sse" };
  registryType?: string;
  registryBaseUrl?: string;
  environmentVariables?: Array<{
    name: string;
    format?: string;
    description?: string;
    isRequired?: boolean;
    isSecret?: boolean;
  }>;
}

export interface CatalogServer {
  $schema?: string;
  name: string;
  title?: string;
  description?: string;
  version?: string;
  websiteUrl?: string;
  icons?: CatalogServerIcon[];
  remotes?: CatalogServerRemote[];
  packages?: CatalogServerPackage[];
  repository?: { url?: string; source?: string; subfolder?: string };
  [key: string]: unknown;
}

/** The `mcp.mesh` extension namespace (deco-specific display/install metadata). */
export interface CatalogMeshMeta {
  id?: string;
  verified?: boolean;
  official?: boolean;
  scopeName?: string;
  appName?: string;
  friendly_name?: string | null;
  friendlyName?: string | null;
  short_description?: string | null;
  mesh_description?: string | null;
  owner?: string | null;
  readme?: string | null;
  readme_url?: string | null;
  tags?: string[];
  categories?: string[];
  has_remote?: boolean;
  has_oauth?: boolean;
  tools?: Array<{ id?: string; name: string; description?: string | null }>;
  [key: string]: unknown;
}

export interface CatalogItemMeta {
  "mcp.mesh"?: CatalogMeshMeta;
  [key: string]: unknown;
}

export interface CatalogItem {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  server: CatalogServer;
  _meta?: CatalogItemMeta;
  [key: string]: unknown;
}

export interface CatalogListQuery {
  search?: string;
  tags?: string[];
  categories?: string[];
  /** Exact `server.name` match (used by the install-by-name path). */
  name?: string;
  limit?: number;
  cursor?: string;
}

export interface CatalogListResult {
  items: CatalogItem[];
  totalCount: number;
  nextCursor?: string;
}

/**
 * A source of catalog items. `load()` returns the source's full item list;
 * the aggregator caches it (single-flight + stale-while-revalidate), merges
 * across sources (first-party first), dedupes, then filters/paginates
 * in-memory. The bounded catalog (~thousands of items) makes an in-memory
 * merged array the simplest correct design.
 */
export interface CatalogSource {
  /** Stable id; also the merge-priority order (lower index = higher priority). */
  readonly id: string;
  load(signal?: AbortSignal): Promise<CatalogItem[]>;
}
