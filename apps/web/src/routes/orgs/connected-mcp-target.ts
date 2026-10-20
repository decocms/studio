import { getUIResourceUri } from "@decocms/shared/mcp-apps/types";

/**
 * Where a freshly-connected MCP should land the user.
 *
 * - `null` — the server answered with no tools, so there is nothing to show.
 *   Stay on the catalog rather than open a blank MCP.
 * - `{ appToolName }` — the MCP ships an app (a tool carrying a `ui://`
 *   resource); open the first one.
 * - `{ appToolName: null }` — tools but no app; open the MCP's own page, which
 *   lands on its tools tab.
 */
export function resolveConnectedMcpTarget(
  tools: { name: string; _meta?: unknown }[] | undefined,
): { appToolName: string | null } | null {
  if (!tools?.length) return null;
  const app = tools.find((tool) => !!getUIResourceUri(tool._meta));
  return { appToolName: app?.name ?? null };
}
