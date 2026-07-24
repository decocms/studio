/**
 * Utility to extract connection data from a registry item for installation.
 * Shared between store server detail and inline installation flows.
 */

import type { OAuthConfig } from "@decocms/shared/sdk/types";
import type { RegistryItem, MCPRegistryServer } from "@/components/store/types";
import { getStudioMcpMetadata } from "@decocms/shared/registry/metadata";
import { getGitHubAvatarUrl } from "@deco/ui/lib/github.ts";
import { getConnectionTypeLabel } from "@/utils/registry-utils";
import { generatePrefixedId } from "@decocms/shared/utils/generate-id";

/**
 * Get the app_name for a registry item — the canonical identifier used to
 * match catalog items to installed connections.
 * Must stay in sync with the app_name field set in extractConnectionData.
 */
export function getRegistryItemAppName(
  item: Pick<RegistryItem, "_meta" | "server">,
): string | null {
  const studioMeta = getStudioMcpMetadata(item._meta);
  return studioMeta?.appName || item.server?.name || null;
}

/**
 * Get a display name for a remote endpoint
 * Uses the hostname (without common suffixes) as the display name
 * Example: "https://graphql.mcp.cloudflare.com/mcp" -> "graphql.mcp.cloudflare.com"
 */
function getRemoteDisplayName(remote?: { url?: string }): string {
  if (!remote?.url) return "Unknown";

  try {
    const url = new URL(remote.url);
    // Return the full hostname as the display name
    return url.hostname;
  } catch {
    return remote.url;
  }
}

/**
 * Get a display name for a package
 */
function getPackageDisplayName(pkg?: {
  identifier?: string;
  name?: string;
}): string {
  const packageName = pkg?.identifier || pkg?.name;
  if (!packageName) return "Unknown";
  // Extract package name (remove scope if present)
  const name = packageName.replace(/^@[^/]+\//, "");
  return name.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Options for extracting connection data
 */
export interface ExtractConnectionDataOptions {
  /** Index of the remote to use (default: 0) */
  remoteIndex?: number;
  /** Index of the package to use for STDIO connections (default: 0) */
  packageIndex?: number;
}

/**
 * Extract connection data from a registry item for installation
 */
export function extractConnectionData(
  item: RegistryItem,
  organizationId: string,
  userId: string,
  options?: ExtractConnectionDataOptions,
) {
  const server = item.server as MCPRegistryServer["server"] | undefined;
  const studioMeta = getStudioMcpMetadata(item._meta);
  const now = new Date().toISOString();

  const baseName =
    studioMeta?.friendlyName ||
    studioMeta?.friendly_name ||
    item.title ||
    server?.title ||
    server?.name ||
    "Unnamed MCP Server";

  const description = server?.description || null;

  // Get icon with GitHub fallback
  const icon =
    server?.icons?.[0]?.src || getGitHubAvatarUrl(server?.repository) || null;

  const rawOauthConfig = studioMeta?.oauth_config as
    | Record<string, unknown>
    | null
    | undefined;
  const oauthConfig: OAuthConfig | null =
    rawOauthConfig &&
    typeof rawOauthConfig.authorizationEndpoint === "string" &&
    typeof rawOauthConfig.tokenEndpoint === "string" &&
    typeof rawOauthConfig.clientId === "string" &&
    Array.isArray(rawOauthConfig.scopes) &&
    (rawOauthConfig.grantType === "authorization_code" ||
      rawOauthConfig.grantType === "client_credentials")
      ? (rawOauthConfig as unknown as OAuthConfig)
      : null;

  const configState = studioMeta?.configuration_state as
    | Record<string, unknown>
    | null
    | undefined;
  const configScopes = studioMeta?.configuration_scopes as
    | string[]
    | null
    | undefined;

  // Extract repository info for README support (stored in metadata)
  const repository = server?.repository
    ? {
        url: server.repository.url,
        source: server.repository.source,
        subfolder: server.repository.subfolder,
      }
    : null;

  // Check if we should use a package (STDIO/NPX) or a remote (HTTP/SSE)
  const packages = server?.packages ?? [];
  const remotes = server?.remotes ?? [];
  const packageIndex = options?.packageIndex ?? 0;
  const remoteIndex = options?.remoteIndex ?? 0;

  // Use a package (STDIO) when the caller explicitly picked one, or when
  // there's no remote to fall back to — otherwise a package-only registry
  // item (no `remotes`) always fell through to the empty-URL "Fallback"
  // branch below, since no caller passes `packageIndex`.
  const usePackage =
    packages.length > 0 &&
    (options?.packageIndex !== undefined || remotes.length === 0);
  const selectedPackage = usePackage ? packages[packageIndex] : null;
  const selectedRemote = !usePackage ? remotes[remoteIndex] : null;

  // Determine connection type and parameters
  let connectionType: "HTTP" | "SSE" | "Websocket" | "STDIO";
  let connectionUrl: string;
  let connectionHeaders: Record<string, unknown> | null = null;

  if (selectedPackage) {
    // STDIO connection using NPX
    const packageName = selectedPackage.identifier || selectedPackage.name;
    connectionType = "STDIO";
    connectionUrl = "";

    // Build envVars from package environmentVariables (with empty values for user to fill)
    const envVars: Record<string, string> = {};
    if (selectedPackage.environmentVariables) {
      for (const envVar of selectedPackage.environmentVariables) {
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
  } else if (selectedRemote) {
    connectionType = (getConnectionTypeLabel(selectedRemote.type) || "HTTP") as
      | "HTTP"
      | "SSE"
      | "Websocket";
    connectionUrl = selectedRemote.url || "";
  } else {
    // Fallback
    connectionType = "HTTP";
    connectionUrl = "";
  }

  // Build title with suffix for multiple options
  const hasMultipleRemotes = remotes.length > 1;
  const hasMultiplePackages = packages.length > 1;
  let titleSuffix = "";

  if (selectedPackage && hasMultiplePackages) {
    titleSuffix = ` (${getPackageDisplayName(selectedPackage)})`;
  } else if (selectedRemote && hasMultipleRemotes) {
    titleSuffix = ` (${getRemoteDisplayName(selectedRemote)})`;
  }

  const title = baseName + titleSuffix;

  return {
    id: generatePrefixedId("conn"),
    title,
    description,
    icon,
    app_name: getRegistryItemAppName(item),
    app_id: studioMeta?.id || item.id || null,
    connection_type: connectionType,
    connection_url: connectionUrl,
    connection_token: null as string | null,
    connection_headers: connectionHeaders,
    oauth_config: oauthConfig,
    configuration_state: configState ?? null,
    configuration_scopes: configScopes ?? null,
    metadata: {
      source: "store",
      registry_item_id: item.id,
      verified: studioMeta?.verified ?? false,
      scopeName: studioMeta?.scopeName ?? null,
      toolsCount: studioMeta?.tools?.length ?? 0,
      publishedAt: studioMeta?.publishedAt ?? null,
      repository,
    },
    created_at: now,
    updated_at: now,
    created_by: userId,
    organization_id: organizationId,
    tools: null,
    bindings: null,
    status: "inactive" as const,
  };
}
