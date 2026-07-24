import {
  getGatewayClientId,
  stripToolNamespace,
} from "@decocms/mcp-utils/aggregate";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getUIResourceUri } from "@decocms/shared/mcp-apps/types";

/**
 * Resolve a stored app-view tool name against the tools currently advertised
 * by its MCP connection. Stored names may predate gateway namespacing, while a
 * live tools/list response may contain either the original or namespaced form.
 */
export function findProjectAppTool(
  tools: Tool[],
  requestedName: string,
): Tool | undefined {
  return (
    tools.find((tool) => tool.name === requestedName) ??
    tools.find((tool) => {
      const clientId = getGatewayClientId(tool._meta);
      if (!clientId) return false;

      const baseName = stripToolNamespace(tool.name, clientId);
      if (baseName === requestedName) return true;

      const requestedBaseName = stripToolNamespace(requestedName, clientId);
      return (
        requestedBaseName !== requestedName && tool.name === requestedBaseName
      );
    })
  );
}

export function hasProjectAppTool(
  tools: Tool[],
  requestedName: string,
): boolean {
  const tool = findProjectAppTool(tools, requestedName);
  return !!tool && !!getUIResourceUri(tool._meta);
}

export interface ProjectAppViewCandidate {
  connectionId: string;
  toolName: string;
}

export interface ProjectAppConnectionTools {
  connectionId: string;
  /**
   * A successful tools/list result. Undefined means the request is still
   * pending or failed, so persisted views must be preserved.
   */
  tools?: Tool[];
}

export function getUnavailableProjectAppViewKeys(
  candidates: ProjectAppViewCandidate[],
  connectionTools: ProjectAppConnectionTools[],
): Set<string> {
  const unavailable = new Set<string>();

  for (const connection of connectionTools) {
    if (!connection.tools) continue;
    for (const candidate of candidates) {
      if (
        candidate.connectionId === connection.connectionId &&
        !hasProjectAppTool(connection.tools, candidate.toolName)
      ) {
        unavailable.add(`${candidate.connectionId}:${candidate.toolName}`);
      }
    }
  }

  return unavailable;
}
