/**
 * React Query keys for Collection Reorder Ranking plugin
 */

export const KEYS = {
  collectionsList: (connectionId: string) =>
    [
      "collection-reorder-ranking",
      "collections",
      "list",
      connectionId,
    ] as const,
  reportsList: (connectionId: string, collectionDbId: number) =>
    [
      "collection-reorder-ranking",
      "reports",
      "list",
      connectionId,
      collectionDbId,
    ] as const,
  report: (connectionId: string, reportId: number) =>
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
