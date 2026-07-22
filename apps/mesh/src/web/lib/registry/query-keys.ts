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
  monitor: (orgId: string) => [...KEYS.all, "monitor", orgId] as const,
  monitorRuns: (orgId: string) => [...KEYS.monitor(orgId), "runs"] as const,
  monitorRunsList: (orgId: string, status?: string) =>
    [...KEYS.monitorRuns(orgId), "list", { status: status ?? "all" }] as const,
  monitorRun: (orgId: string, runId?: string) =>
    [...KEYS.monitorRuns(orgId), "run", runId ?? "none"] as const,
  monitorResults: (orgId: string) =>
    [...KEYS.monitor(orgId), "results"] as const,
  monitorResultsList: (orgId: string, runId?: string, status?: string) =>
    [
      ...KEYS.monitorResults(orgId),
      "list",
      { runId: runId ?? "none", status: status ?? "all" },
    ] as const,
  monitorConnections: (orgId: string) =>
    [...KEYS.monitor(orgId), "connections"] as const,
  monitorConnectionAuthProbe: (orgId: string, connectionId: string) =>
    [...KEYS.monitorConnections(orgId), "auth-probe", connectionId] as const,
};
