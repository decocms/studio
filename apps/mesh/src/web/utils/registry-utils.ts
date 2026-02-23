/**
 * Shared utilities for registry operations
 * Centralizes duplicated logic across store-related files
 */

import { createMCPClient } from "@decocms/mesh-sdk";

/**
 * Find the LIST tool from a tools array
 * Returns the tool name if found, empty string otherwise
 */
export function findListToolName(
  tools?: Array<{ name: string }> | null,
): string {
  if (!tools) return "";
  const preferred = tools.find(
    (tool) => tool.name === "COLLECTION_REGISTRY_APP_LIST",
  );
  if (preferred) return preferred.name;

  const privateRegistryList = tools.find(
    (tool) => tool.name === "REGISTRY_ITEM_LIST",
  );
  if (privateRegistryList) return privateRegistryList.name;

  const registryList = tools.find(
    (tool) =>
      tool.name.startsWith("COLLECTION_REGISTRY_APP_") &&
      tool.name.endsWith("_LIST"),
  );
  if (registryList) return registryList.name;
  return "";
}

/**
 * Find the FILTERS tool from a tools array
 * Returns the tool name if found, empty string otherwise
 * Note: Not all registries support filters
 */
export function findFiltersToolName(
  tools?: Array<{ name: string }> | null,
): string {
  if (!tools) return "";
  const preferred = tools.find(
    (tool) => tool.name === "COLLECTION_REGISTRY_APP_FILTERS",
  );
  if (preferred) return preferred.name;

  const privateRegistryFilters = tools.find(
    (tool) => tool.name === "REGISTRY_ITEM_FILTERS",
  );
  if (privateRegistryFilters) return privateRegistryFilters.name;

  const filtersTool = tools.find(
    (tool) =>
      tool.name.startsWith("COLLECTION_REGISTRY_APP_") &&
      tool.name.endsWith("_FILTERS"),
  );
  if (filtersTool) return filtersTool.name;
  return "";
}

/**
 * Find a REGISTRY_APP tool by suffix (e.g., "_GET", "_VERSIONS")
 */
export function findRegistryToolBySuffix(
  tools: Array<{ name: string }> | null | undefined,
  suffix: "_GET" | "_VERSIONS" | "_SEARCH",
): string {
  if (!tools) return "";

  const preferred = tools.find(
    (tool) => tool.name === `COLLECTION_REGISTRY_APP${suffix}`,
  );
  if (preferred) return preferred.name;

  const privateRegistryToolNameBySuffix: Record<
    "_GET" | "_VERSIONS" | "_SEARCH",
    string
  > = {
    _GET: "REGISTRY_ITEM_GET",
    _VERSIONS: "REGISTRY_ITEM_VERSIONS",
    _SEARCH: "REGISTRY_ITEM_SEARCH",
  };
  const privateRegistryTool = tools.find(
    (tool) => tool.name === privateRegistryToolNameBySuffix[suffix],
  );
  if (privateRegistryTool) return privateRegistryTool.name;

  const registryTool = tools.find(
    (tool) =>
      tool.name.startsWith("COLLECTION_REGISTRY_APP_") &&
      tool.name.endsWith(suffix),
  );
  if (registryTool) return registryTool.name;
  return "";
}

/**
 * Flatten paginated items from multiple pages into a single array
 * Handles both direct array responses and nested array responses
 */
export function flattenPaginatedItems<T>(pages?: unknown[]): T[] {
  if (!pages) return [];

  const items: T[] = [];

  for (const page of pages) {
    let pageItems: T[] = [];

    if (Array.isArray(page)) {
      pageItems = page;
    } else if (typeof page === "object" && page !== null) {
      const itemsKey = Object.keys(page).find((key) =>
        Array.isArray(page[key as keyof typeof page]),
      );
      if (itemsKey) {
        pageItems = page[itemsKey as keyof typeof page] as T[];
      }
    }

    items.push(...pageItems);
  }

  return items;
}

/**
 * Map remote connection types to human-readable labels
 */
const CONNECTION_TYPE_MAP: Record<string, string> = {
  "streamable-http": "HTTP",
  http: "HTTP",
  sse: "SSE",
  stdio: "STDIO",
  websocket: "Websocket",
};

/**
 * Get human-readable label for a connection type
 * Returns uppercase version if type not in map, or null if no type provided
 */
export function getConnectionTypeLabel(remoteType?: string): string | null {
  if (!remoteType) return null;
  return CONNECTION_TYPE_MAP[remoteType] ?? remoteType.toUpperCase();
}

/**
 * Extract schema version from a schema URL
 * Example: "https://schemas/2024-11-21" -> "2024-11-21"
 */
export function extractSchemaVersion(schemaUrl?: string): string | null {
  if (!schemaUrl) return null;
  const match = schemaUrl.match(/schemas\/([\d-]+)/);
  return match?.[1] ?? null;
}

/**
 * Extract items array from various response formats
 * Handles both direct array responses and nested array responses
 */
export function extractItemsFromResponse<T>(response: unknown): T[] {
  if (!response) return [];

  // Direct array response
  if (Array.isArray(response)) {
    return response;
  }

  // Object with nested array
  if (typeof response === "object" && response !== null) {
    const itemsKey = Object.keys(response).find((key) =>
      Array.isArray(response[key as keyof typeof response]),
    );

    if (itemsKey) {
      return response[itemsKey as keyof typeof response] as T[];
    }
  }

  return [];
}

/**
 * Call a tool on a registry connection.
 * Creates a client, calls the tool, and properly closes the client.
 *
 * @param registryId - The connection ID of the registry
 * @param orgId - The organization ID
 * @param toolName - The name of the tool to call
 * @param args - The tool arguments
 * @returns The tool result (with structuredContent extracted if available)
 */
export async function callRegistryTool<TOutput>(
  registryId: string,
  orgId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<TOutput> {
  const client = await createMCPClient({
    connectionId: registryId,
    orgId,
  });

  try {
    const result = (await client.callTool({
      name: toolName,
      arguments: args,
    })) as { structuredContent?: unknown };
    return (result.structuredContent ?? result) as TOutput;
  } finally {
    await client.close().catch(console.error);
  }
}
