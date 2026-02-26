/**
 * React Query keys for Declare plugin
 */

export const KEYS = {
  pluginConfig: (projectId: string, pluginId: string) =>
    ["project-plugin-config", projectId, pluginId] as const,
  planningCheck: (connectionId: string) =>
    ["declare", "planning-check", connectionId] as const,
  serverPort: (connectionId: string) =>
    ["declare", "server-port", connectionId] as const,
  serverCheck: (connectionId: string, port: number) =>
    ["declare", "server-check", connectionId, port] as const,
} as const;
