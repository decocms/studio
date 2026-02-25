/**
 * React Query keys for Preview plugin
 */

export const KEYS = {
  previewConfig: (connectionId: string) =>
    ["preview", "config", connectionId] as const,
  pluginConfig: (projectId: string, pluginId: string) =>
    ["project-plugin-config", projectId, pluginId] as const,
  detect: (connectionId: string) =>
    ["preview", "detect", connectionId] as const,
  serverCheck: (connectionId: string, port: number) =>
    ["preview", "server-check", connectionId, port] as const,
} as const;
