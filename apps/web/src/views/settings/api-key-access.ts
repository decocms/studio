import type { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";

export type ApiKeyAccessMode = "read-only" | "custom" | "full";

export const API_KEY_EXPIRY_OPTIONS = [
  "7",
  "30",
  "90",
  "365",
  "never",
] as const;
export type ApiKeyExpiry = (typeof API_KEY_EXPIRY_OPTIONS)[number];

const SECONDS_PER_DAY = 86_400;

/** Names, not a wildcard: a tool added later stays out of the key until someone grants it. */
export function readOnlyToolNames(tools: ListToolsResult["tools"]): string[] {
  return tools
    .filter((tool) => tool.annotations?.readOnlyHint === true)
    .map((tool) => tool.name);
}

/** Studio's own tools live under `self`; a connection's under its id. */
export const STUDIO_RESOURCE = "self";

export function keyPermissions(
  mode: ApiKeyAccessMode,
  readOnlyTools: string[],
  customTools: Record<string, string[]>,
): Record<string, string[]> {
  if (mode === "full") return { "*": ["*"] };
  if (mode === "read-only") return { [STUDIO_RESOURCE]: readOnlyTools };
  return Object.fromEntries(
    Object.entries(customTools).filter(([, tools]) => tools.length > 0),
  );
}

export function countTools(toolSet: Record<string, string[]>): number {
  return Object.values(toolSet).reduce((sum, tools) => sum + tools.length, 0);
}

export function expiresInSeconds(expiry: ApiKeyExpiry): number | undefined {
  return expiry === "never" ? undefined : Number(expiry) * SECONDS_PER_DAY;
}

export type KeyAccessSummary =
  | { kind: "full" }
  | { kind: "tools"; count: number };

/** Same global-grant rule as `resolveCapabilities`: only `*` or `self` wildcards cover every tool. */
export function summarizeKeyAccess(
  permissions: Record<string, string[]>,
): KeyAccessSummary {
  const list = (resource: string) => {
    const value = permissions[resource];
    return Array.isArray(value) ? value : [];
  };
  if (list("*").includes("*") || list("self").includes("*")) {
    return { kind: "full" };
  }
  const granted = new Set<string>();
  for (const resource of Object.keys(permissions)) {
    for (const action of list(resource)) {
      if (!action.startsWith("!")) granted.add(`${resource}:${action}`);
    }
  }
  return { kind: "tools", count: granted.size };
}
