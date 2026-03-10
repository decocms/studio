/**
 * Server-side registry lookup utilities
 *
 * Used to fetch app details from a registry connection at template creation time.
 */

import type { RequiredApp } from "../storage/types";

/** Registry item structure from registry MCP */
interface RegistryItem {
  id: string;
  name?: string;
  title?: string;
  description?: string;
  server?: {
    name?: string;
    title?: string;
    description?: string;
    icons?: Array<{ src?: string }>;
    repository?: {
      url?: string;
      source?: string;
      subfolder?: string;
    };
    remotes?: Array<{
      type?: string;
      url?: string;
      name?: string;
      title?: string;
      description?: string;
      headers?: Array<{ name?: string; value?: string }>;
    }>;
    packages?: Array<{
      name?: string;
      identifier?: string;
      environmentVariables?: Array<{ name?: string }>;
    }>;
  };
  _meta?: {
    /** Deco Studio metadata - the standard key */
    "mcp.mesh"?: {
      friendlyName?: string;
      friendly_name?: string;
      oauth_config?: {
        authorizationEndpoint?: string;
        tokenEndpoint?: string;
        clientId?: string;
        scopes?: string[];
        grantType?: "authorization_code" | "client_credentials";
      };
      configuration_state?: Record<string, unknown>;
      configuration_scopes?: string[];
    };
  };
}

/** Mesh context with createMCPProxy - accepts any proxy-like object */
interface MeshContextWithProxy {
  createMCPProxy: (connectionId: string) => Promise<{
    callTool: (params: {
      name: string;
      arguments?: Record<string, unknown>;
    }) => Promise<unknown>;
    listTools: () => Promise<{ tools: Array<{ name: string }> }>;
    close: () => Promise<void>;
    [key: string]: unknown; // Allow other Client methods
  }>;
}

/** The metadata key used by Deco Studio registry - must match apps/mesh/src/core/constants.ts */
const MCP_MESH_KEY = "mcp.mesh" as const;

/** Map remote connection types to standard types */
const CONNECTION_TYPE_MAP: Record<
  string,
  "HTTP" | "SSE" | "Websocket" | "STDIO"
> = {
  "streamable-http": "HTTP",
  http: "HTTP",
  sse: "SSE",
  stdio: "STDIO",
  websocket: "Websocket",
};

/**
 * Get GitHub avatar URL from repository info
 */
function getGitHubAvatarUrl(repository?: {
  url?: string;
  source?: string;
}): string | null {
  if (!repository?.url) return null;
  try {
    const url = new URL(repository.url);
    if (url.hostname === "github.com") {
      const pathParts = url.pathname.split("/").filter(Boolean);
      if (pathParts.length >= 1) {
        return `https://github.com/${pathParts[0]}.png`;
      }
    }
  } catch {
    // Invalid URL
  }
  return null;
}

/**
 * Find the LIST tool from a registry's tools
 */
function findListToolName(tools: Array<{ name: string }>): string | null {
  const listTool = tools.find((tool) => tool.name.endsWith("_LIST"));
  return listTool?.name ?? null;
}

/**
 * Extract items array from various response formats
 */
function extractItemsFromResponse<T>(response: unknown): T[] {
  if (!response) return [];

  // Direct array response
  if (Array.isArray(response)) {
    return response;
  }

  // Object with nested array
  if (typeof response === "object" && response !== null) {
    const itemsKey = Object.keys(response).find((key) =>
      Array.isArray((response as Record<string, unknown>)[key]),
    );

    if (itemsKey) {
      return (response as Record<string, unknown>)[itemsKey] as T[];
    }
  }

  return [];
}

/**
 * Extract RequiredApp data from a registry item
 */
function extractRequiredAppFromRegistryItem(
  item: RegistryItem,
  selectedTools: string[] | null,
  selectedResources: string[] | null,
  selectedPrompts: string[] | null,
): Omit<RequiredApp, "app_name"> {
  const server = item.server;
  const meshMeta = item._meta?.[MCP_MESH_KEY];

  // Extract title
  const title =
    meshMeta?.friendlyName ||
    meshMeta?.friendly_name ||
    item.title ||
    server?.title ||
    server?.name ||
    "Unnamed MCP Server";

  // Extract description
  const description = server?.description || null;

  // Extract icon with GitHub fallback
  const icon =
    server?.icons?.[0]?.src || getGitHubAvatarUrl(server?.repository) || null;

  // Extract OAuth config
  const rawOauthConfig = meshMeta?.oauth_config;
  const oauthConfig =
    rawOauthConfig &&
    typeof rawOauthConfig.authorizationEndpoint === "string" &&
    typeof rawOauthConfig.tokenEndpoint === "string" &&
    typeof rawOauthConfig.clientId === "string" &&
    Array.isArray(rawOauthConfig.scopes) &&
    (rawOauthConfig.grantType === "authorization_code" ||
      rawOauthConfig.grantType === "client_credentials")
      ? {
          authorizationEndpoint: rawOauthConfig.authorizationEndpoint,
          tokenEndpoint: rawOauthConfig.tokenEndpoint,
          clientId: rawOauthConfig.clientId,
          scopes: rawOauthConfig.scopes,
          grantType: rawOauthConfig.grantType,
        }
      : null;

  // Determine connection type and URL from remotes or packages
  const packages = server?.packages ?? [];
  const remotes = server?.remotes ?? [];

  let connectionType: "HTTP" | "SSE" | "Websocket" | "STDIO";
  let connectionUrl: string | null;
  let connectionHeaders: RequiredApp["connection_headers"] = null;

  // Prefer remotes (HTTP/SSE) over packages (STDIO)
  const remote = remotes[0];
  const pkg = packages[0];

  if (remote) {
    connectionType =
      CONNECTION_TYPE_MAP[remote.type ?? ""] ??
      (remote.type?.toUpperCase() as "HTTP" | "SSE" | "Websocket") ??
      "HTTP";
    connectionUrl = remote.url ?? null;

    // Extract headers if present
    if (remote.headers && remote.headers.length > 0) {
      const headers: Record<string, string> = {};
      for (const h of remote.headers) {
        if (h.name && h.value) {
          headers[h.name] = h.value;
        }
      }
      if (Object.keys(headers).length > 0) {
        connectionHeaders = { headers };
      }
    }
  } else if (pkg) {
    connectionType = "STDIO";
    connectionUrl = null;

    // Build STDIO connection parameters
    const packageName = pkg.identifier || pkg.name;
    const envVars: Record<string, string> = {};
    if (pkg.environmentVariables) {
      for (const envVar of pkg.environmentVariables) {
        if (envVar.name) {
          envVars[envVar.name] = "";
        }
      }
    }

    connectionHeaders = {
      command: "npx",
      args: packageName ? ["-y", packageName] : [],
      ...(Object.keys(envVars).length > 0 && { envVars }),
    };
  } else {
    // Fallback
    connectionType = "HTTP";
    connectionUrl = null;
  }

  return {
    title,
    description,
    icon,
    connection_type: connectionType,
    connection_url: connectionUrl,
    connection_headers: connectionHeaders,
    oauth_config: oauthConfig,
    selected_tools: selectedTools,
    selected_resources: selectedResources,
    selected_prompts: selectedPrompts,
  };
}

/**
 * Lookup app details from a registry connection.
 *
 * @param ctx - Mesh context with createMCPProxy
 * @param registryId - Connection ID of the registry
 * @param appName - App name to look up (e.g., "@deco/openrouter")
 * @param selectedTools - Optional tool selection
 * @param selectedResources - Optional resource selection
 * @param selectedPrompts - Optional prompt selection
 * @returns RequiredApp data or throws if not found
 */
async function lookupAppFromRegistry(
  ctx: MeshContextWithProxy,
  registryId: string,
  appName: string,
  selectedTools: string[] | null = null,
  selectedResources: string[] | null = null,
  selectedPrompts: string[] | null = null,
): Promise<RequiredApp> {
  // Create proxy to registry
  const proxy = await ctx.createMCPProxy(registryId);

  try {
    // Find the LIST tool
    const toolsResult = await proxy.listTools();
    const listToolName = findListToolName(toolsResult.tools);

    if (!listToolName) {
      throw new Error(`Registry "${registryId}" does not have a LIST tool`);
    }

    // Call LIST with appName filter
    const result = await proxy.callTool({
      name: listToolName,
      arguments: { where: { appName } },
    });

    // Extract items from response
    const structuredResult =
      (result as { structuredContent?: unknown }).structuredContent ?? result;
    const items = extractItemsFromResponse<RegistryItem>(structuredResult);

    const registryItem = items[0];
    if (!registryItem) {
      throw new Error(`App "${appName}" not found in registry "${registryId}"`);
    }

    // Extract RequiredApp data
    const appData = extractRequiredAppFromRegistryItem(
      registryItem,
      selectedTools,
      selectedResources,
      selectedPrompts,
    );

    return {
      app_name: appName,
      ...appData,
    };
  } finally {
    await proxy.close().catch(console.error);
  }
}

/**
 * Lookup multiple apps from a registry connection.
 */
export async function lookupAppsFromRegistry(
  ctx: MeshContextWithProxy,
  registryId: string,
  apps: Array<{
    app_name: string;
    selected_tools?: string[] | null;
    selected_resources?: string[] | null;
    selected_prompts?: string[] | null;
  }>,
): Promise<RequiredApp[]> {
  const results: RequiredApp[] = [];

  for (const app of apps) {
    const requiredApp = await lookupAppFromRegistry(
      ctx,
      registryId,
      app.app_name,
      app.selected_tools ?? null,
      app.selected_resources ?? null,
      app.selected_prompts ?? null,
    );
    results.push(requiredApp);
  }

  return results;
}
