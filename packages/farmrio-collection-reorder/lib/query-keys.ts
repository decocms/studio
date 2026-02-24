/**
 * React Query keys for Collection Reorder Ranking plugin
 */

export const KEYS = {
  reportsList: (connectionId: string) =>
    ["collection-reorder-ranking", "reports", "list", connectionId] as const,
  report: (connectionId: string, reportId: string) =>
    [
      "collection-reorder-ranking",
      "reports",
      "detail",
      connectionId,
      reportId,
    ] as const,
  pluginConfig: (projectId: string, pluginId: string) =>
    ["project-plugin-config", projectId, pluginId] as const,
} as const;
