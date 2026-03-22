/**
 * Context Hook
 *
 * Provides dynamic context for the AI assistant based on:
 * - Current route parameters (connection, collection, item)
 * - Selected virtual MCP (agent) and its custom instructions
 *
 * This hook only returns context information; base system instructions
 * are handled server-side in models.ts (DECOPILOT_SYSTEM_PROMPT).
 */

import { useMatch } from "@tanstack/react-router";

/**
 * Hook that generates context for the AI assistant based on current state
 *
 * @param virtualMcpId - The selected virtual MCP (agent) ID (optional)
 * @returns Context string to be sent to the backend
 */
export function useContext(virtualMcpId?: string | null): string {
  // Extract route parameters directly using useParams
  const collectionMatch = useMatch({
    from: "/shell/$org/mcps/$appSlug/$collectionName/$itemId",
    shouldThrow: false,
  });

  const contextParts: string[] = [];

  // Add virtual MCP context if selected
  if (virtualMcpId) {
    contextParts.push(`### Selected Agent
- ID: ${virtualMcpId}`);
  }

  // Add route context based on available params
  const routeContextParts: string[] = [];

  if (collectionMatch?.params.appSlug) {
    routeContextParts.push(
      `- Connection ID: ${collectionMatch?.params.appSlug}`,
    );
  }

  if (collectionMatch?.params.collectionName) {
    routeContextParts.push(
      `- Collection: ${collectionMatch?.params.collectionName}`,
    );
  }

  if (collectionMatch?.params.itemId) {
    routeContextParts.push(`- Item ID: ${collectionMatch?.params.itemId}`);
  }

  if (routeContextParts.length > 0) {
    contextParts.push(`### Current Resource
The user is viewing the following resource:
${routeContextParts.join("\n")}

Help the user understand and work with this resource.`);
  }

  return contextParts.join("\n\n");
}
