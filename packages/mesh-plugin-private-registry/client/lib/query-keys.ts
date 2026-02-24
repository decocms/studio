export const KEYS = {
  all: ["private-registry"] as const,
  items: () => [...KEYS.all, "items"] as const,
  itemsList: (
    search: string,
    tags: string[],
    categories: string[],
    limit?: number,
  ) => [...KEYS.items(), "list", { search, tags, categories, limit }] as const,
  item: (id: string) => [...KEYS.items(), "item", id] as const,
  filters: () => [...KEYS.all, "filters"] as const,
  registryConfig: () => [...KEYS.all, "registry-config"] as const,
  registryConfigByPlugin: (projectId: string, pluginId: string) =>
    [...KEYS.registryConfig(), projectId, pluginId] as const,
  publishRequests: () => [...KEYS.all, "publish-requests"] as const,
  publishRequestsByOrg: (orgId: string) =>
    [...KEYS.publishRequests(), "org", orgId] as const,
  publishRequestsList: (
    status?: string,
    sortBy?: "created_at" | "title",
    sortDirection?: "asc" | "desc",
  ) =>
    [
      ...KEYS.publishRequests(),
      "list",
      {
        status: status ?? "all",
        sortBy: sortBy ?? "created_at",
        sortDirection: sortDirection ?? "desc",
      },
    ] as const,
  publishRequestsListByOrg: (
    orgId: string,
    status?: string,
    sortBy?: "created_at" | "title",
    sortDirection?: "asc" | "desc",
  ) =>
    [
      ...KEYS.publishRequestsByOrg(orgId),
      "list",
      {
        status: status ?? "all",
        sortBy: sortBy ?? "created_at",
        sortDirection: sortDirection ?? "desc",
      },
    ] as const,
  publishRequestsCount: () => [...KEYS.publishRequests(), "count"] as const,
  publishRequestsCountByOrg: (orgId: string) =>
    [...KEYS.publishRequestsByOrg(orgId), "count"] as const,
  publishApiKeys: () => [...KEYS.all, "publish-api-keys"] as const,
  monitor: () => [...KEYS.all, "monitor"] as const,
  monitorRuns: () => [...KEYS.monitor(), "runs"] as const,
  monitorRunsList: (status?: string) =>
    [...KEYS.monitorRuns(), "list", { status: status ?? "all" }] as const,
  monitorRun: (runId?: string) =>
    [...KEYS.monitorRuns(), "run", runId ?? "none"] as const,
  monitorResults: () => [...KEYS.monitor(), "results"] as const,
  monitorResultsList: (runId?: string, status?: string) =>
    [
      ...KEYS.monitorResults(),
      "list",
      { runId: runId ?? "none", status: status ?? "all" },
    ] as const,
  monitorConnections: () => [...KEYS.monitor(), "connections"] as const,
  monitorConnectionAuthProbe: (connectionId: string) =>
    [...KEYS.monitorConnections(), "auth-probe", connectionId] as const,
};
