/**
 * Store Types
 *
 * Centralized types for store discovery and registry items.
 */

/**
 * MCP Registry Server icon structure
 */
export interface MCPRegistryServerIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: "light" | "dark";
}

/**
 * MCP Registry Server metadata structure
 */
export interface MCPRegistryServerMeta {
  "mcp.mesh"?: {
    id: string;
    verified?: boolean;
    scopeName?: string;
    appName?: string;
    publishedAt?: string;
    updatedAt?: string;
    friendly_name?: string;
    short_description?: string;
    owner?: string | null;
    readme?: string | null;
    readme_url?: string | null;
    mesh_description?: string;
    tags?: string[];
    categories?: string[];
    official?: boolean;
    friendlyName?: string | null;
    oauth_config?: Record<string, unknown>;
    configuration_state?: Record<string, unknown>;
    configuration_scopes?: string[];
    tools?: Array<{
      id: string;
      name: string;
      description?: string | null;
    }>;
    models?: unknown[];
    emails?: unknown[];
    analytics?: unknown;
    cdn?: unknown;
  };
  [key: string]: unknown;
}

/**
 * MCP Registry Server structure from LIST response
 */
export interface MCPRegistryServer {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  _meta?: MCPRegistryServerMeta;
  server: {
    $schema?: string;
    name: string;
    title?: string;
    description?: string;
    icons?: MCPRegistryServerIcon[];
    remotes?: Array<{
      type: "http" | "stdio" | "sse";
      url?: string;
    }>;
    packages?: Array<{
      identifier: string;
      name?: string;
      version?: string;
      transport?: {
        type: "stdio" | "http" | "sse";
      };
      registryType?: string;
      registryBaseUrl?: string;
      environmentVariables?: Array<{
        name: string;
        format?: string;
        description?: string;
        isRequired?: boolean;
        isSecret?: boolean;
      }>;
    }>;
    version?: string;
    repository?: {
      url?: string;
      source?: string;
      subfolder?: string;
    };
  };
}

/**
 * Generic registry item that can come from various JSON structures.
 * Different registries may use different property names for similar concepts.
 */
export interface RegistryItem {
  /** Unique identifier for the item */
  id: string;
  /** Primary name of the item */
  name?: string;
  /** Alternative name field used by some registries */
  title?: string;
  /** Primary description of the item */
  description?: string;
  /** Alternative description field used by some registries */
  summary?: string;
  /** Icon URL */
  icon?: string;
  /** Alternative icon field */
  image?: string;
  /** Alternative icon field */
  logo?: string;
  /** Whether the item is verified */
  verified?: boolean;
  /** Publisher name */
  publisher?: string;
  /** Publisher logo URL */
  publisher_logo?: string;
  /** Available tools */
  tools?: Array<{
    id?: string;
    name?: string;
    description?: string | null;
  }>;
  /** Available models */
  models?: unknown[];
  /** Available emails */
  emails?: unknown[];
  /** Analytics configuration */
  analytics?: unknown;
  /** CDN configuration */
  cdn?: unknown;
  /** Metadata with various provider-specific information */
  _meta?: MCPRegistryServerMeta;
  /** Visibility flag used by private-registry based stores */
  is_public?: boolean;
  /** Alternative metadata field */
  meta?: {
    verified?: boolean;
    [key: string]: unknown;
  };
  /** Nested server object (used by MCPRegistryServer format) - always present */
  server: {
    $schema?: string;
    name: string;
    title?: string;
    description?: string;
    version?: string;
    websiteUrl?: string;
    repository?: {
      url?: string;
      source?: string;
      subfolder?: string;
    };
    remotes?: Array<{
      type?: string;
      url?: string;
      /** Display name for this remote endpoint */
      name?: string;
      /** Display title for this remote endpoint */
      title?: string;
      /** Description of what this remote endpoint does */
      description?: string;
      headers?: Array<{
        name?: string;
        value?: string;
        description?: string;
      }>;
      // STDIO-specific fields
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    }>;
    // NPM packages for STDIO connections
    packages?: Array<{
      /** Package identifier (e.g., "mcp-jira-server") */
      identifier: string;
      /** Package name (alternative to identifier) */
      name?: string;
      version?: string;
      /** Transport configuration */
      transport?: {
        type: "stdio" | "http" | "sse";
      };
      /** Registry type (e.g., "npm") */
      registryType?: string;
      /** Registry base URL (e.g., "https://registry.npmjs.org") */
      registryBaseUrl?: string;
      /** Environment variables required by the package */
      environmentVariables?: Array<{
        name: string;
        format?: string;
        description?: string;
        isRequired?: boolean;
        isSecret?: boolean;
      }>;
      /** Legacy fields */
      runtime?: string;
      registryUrl?: string;
      env?: string[];
    }>;
    icons?: Array<{ src: string }>;
    tools?: unknown[];
    models?: unknown[];
    emails?: unknown[];
    analytics?: unknown;
    cdn?: unknown;
  };
  /** When the item was last updated */
  updated_at?: string | Date;
}

/** Filter item with value and count */
export interface FilterItem {
  value: string;
  count: number;
}

/** Response from COLLECTION_REGISTRY_APP_FILTERS tool */
export interface RegistryFiltersResponse {
  tags?: FilterItem[];
  categories?: FilterItem[];
}

/** Active filters state */
export interface ActiveFilters {
  tags: string[];
  categories: string[];
}

// ============================================================================
// Server List Types (for remote/package selection)
// ============================================================================

/** Protocol types for server connections */
export type Protocol = "http" | "sse" | "stdio";

/** Unified server entry combining remotes and packages */
export type UnifiedServerEntry = {
  type?: string;
  url?: string;
  name?: string;
  title?: string;
  description?: string;
  _type: "remote" | "package";
  _index: number;
};

/** Processed server card data for display */
export interface ServerCardData {
  index: number;
  protocol: Protocol;
  url?: string;
  hostname: string;
  serviceName: string;
  displayName: string;
  name?: string;
  title?: string;
  description?: string;
  _type: "remote" | "package";
  _index: number;
}

/** Protocol filter option */
export interface ProtocolFilterOption {
  value: Protocol | "all";
  label: string;
}
