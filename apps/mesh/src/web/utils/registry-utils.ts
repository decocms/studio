/**
 * Shared utilities for registry operations
 * Centralizes duplicated logic across store-related files
 */

import { createMCPClient, WellKnownOrgMCPId } from "@decocms/mesh-sdk";

/**
 * Check if a connection ID belongs to a well-known (non-private) registry.
 */
function isWellKnownRegistry(connectionId: string, orgId: string): boolean {
  return (
    connectionId === WellKnownOrgMCPId.REGISTRY(orgId) ||
    connectionId === WellKnownOrgMCPId.COMMUNITY_REGISTRY(orgId)
  );
}

/**
 * Infer the LIST tool name for a registry based on its connection ID.
 * Well-known registries (Deco Store, Community) use COLLECTION_REGISTRY_APP_LIST.
 * Private registries use REGISTRY_ITEM_LIST.
 */
export function inferRegistryListToolName(
  connectionId: string,
  orgId: string,
): string {
  if (isWellKnownRegistry(connectionId, orgId)) {
    return "COLLECTION_REGISTRY_APP_LIST";
  }
  return "REGISTRY_ITEM_LIST";
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
  orgSlug: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<TOutput> {
  const client = await createMCPClient({
    connectionId: registryId,
    orgId,
    orgSlug,
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
