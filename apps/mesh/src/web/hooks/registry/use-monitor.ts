import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { PLUGIN_ID } from "@/tools/registry/shared";
import { KEYS } from "@/web/lib/registry/query-keys";
import type {
  RegistryMonitorConfig,
  MonitorConnectionListResponse,
  MonitorResultListResponse,
  MonitorResultStatus,
  MonitorRun,
  MonitorRunListResponse,
  MonitorRunStatus,
} from "@/web/lib/registry/types";

type ToolResult<T> = { structuredContent?: T } & T;

async function callTool<T>(
  client: ReturnType<typeof useMCPClient>,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = (await client.callTool({
    name,
    arguments: args,
  })) as
    | (ToolResult<T> & {
        isError?: boolean;
        content?: Array<{ type?: string; text?: string }>;
      })
    | undefined;

  if (!result || typeof result !== "object") {
    throw new Error(`Invalid tool response for ${name}`);
  }

  if (result.isError) {
    const message =
      result.content?.find((item) => item.type === "text")?.text ??
      `Tool ${name} returned an error`;
    throw new Error(message);
  }

  return (result.structuredContent ?? result) as T;
}

export function useMonitorRunStart() {
  const queryClient = useQueryClient();
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  return useMutation({
    mutationFn: async (config?: Partial<RegistryMonitorConfig>) =>
      callTool<{ run: MonitorRun }>(client, "REGISTRY_MONITOR_RUN_START", {
        config,
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: KEYS.monitorRuns() }),
        queryClient.invalidateQueries({ queryKey: KEYS.monitorResults() }),
      ]);
    },
  });
}

export function useMonitorRunCancel() {
  const queryClient = useQueryClient();
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  return useMutation({
    mutationFn: async (runId: string) =>
      callTool<{ run: MonitorRun }>(client, "REGISTRY_MONITOR_RUN_CANCEL", {
        runId,
      }),
    onSuccess: async (_res, runId) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: KEYS.monitorRuns() }),
        queryClient.invalidateQueries({ queryKey: KEYS.monitorRun(runId) }),
      ]);
    },
  });
}

export function useMonitorRuns(status?: MonitorRunStatus) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  return useQuery({
    queryKey: KEYS.monitorRunsList(status),
    queryFn: async () =>
      callTool<MonitorRunListResponse>(client, "REGISTRY_MONITOR_RUN_LIST", {
        status,
        limit: 100,
      }),
    staleTime: 5_000,
  });
}

export function useMonitorRun(runId?: string) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  return useQuery({
    queryKey: KEYS.monitorRun(runId),
    queryFn: async () =>
      callTool<{ run: MonitorRun | null }>(client, "REGISTRY_MONITOR_RUN_GET", {
        runId,
      }),
    enabled: Boolean(runId),
    refetchInterval: (query) => {
      const run = query.state.data?.run;
      return run?.status === "running" ? 5000 : false;
    },
  });
}

export function useMonitorResults(
  runId?: string,
  status?: MonitorResultStatus,
  runStatus?: MonitorRunStatus,
) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  return useQuery({
    queryKey: KEYS.monitorResultsList(runId, status),
    queryFn: async () =>
      callTool<MonitorResultListResponse>(
        client,
        "REGISTRY_MONITOR_RESULT_LIST",
        {
          runId,
          status,
          limit: 200,
          offset: 0,
        },
      ),
    enabled: Boolean(runId),
    staleTime: 5_000,
    refetchInterval: runStatus === "running" ? 2500 : false,
  });
}

export function useMonitorConnections() {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  return useQuery({
    queryKey: KEYS.monitorConnections(),
    queryFn: async () =>
      callTool<MonitorConnectionListResponse>(
        client,
        "REGISTRY_MONITOR_CONNECTION_LIST",
        {},
      ),
    staleTime: 10_000,
  });
}

export function useSyncMonitorConnections() {
  const queryClient = useQueryClient();
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  return useMutation({
    mutationFn: async () =>
      callTool<{ created: number; updated: number }>(
        client,
        "REGISTRY_MONITOR_CONNECTION_SYNC",
        {},
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: KEYS.monitorConnections(),
      });
    },
  });
}

export function useUpdateMonitorConnectionAuth() {
  const queryClient = useQueryClient();
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  return useMutation({
    mutationFn: async ({
      connectionId,
      authStatus,
    }: {
      connectionId: string;
      authStatus: string;
    }) =>
      callTool<{ success: boolean }>(
        client,
        "REGISTRY_MONITOR_CONNECTION_UPDATE_AUTH",
        { connectionId, authStatus },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: KEYS.monitorConnections(),
      });
    },
  });
}

type PluginConfigResponse = {
  config: {
    settings: Record<string, unknown> | null;
  } | null;
};

const DEFAULT_MONITOR_SETTINGS: RegistryMonitorConfig = {
  monitorMode: "health_check",
  onFailure: "none",
  schedule: "manual",
  cronExpression: "",
  scheduleEventId: "",
  perMcpTimeoutMs: 30_000,
  perToolTimeoutMs: 10_000,
  maxAgentSteps: 15,
  testPublicOnly: false,
  testPrivateOnly: false,
  includePendingRequests: false,
  agentContext: "",
};

export function useRegistryMonitorConfig() {
  const { org, project } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: KEYS.registryConfigByPlugin(project.id ?? "", PLUGIN_ID),
    queryFn: async () =>
      callTool<PluginConfigResponse>(client, "VIRTUAL_MCP_PLUGIN_CONFIG_GET", {
        virtualMcpId: project.id,
        pluginId: PLUGIN_ID,
      }),
    enabled: Boolean(project.id),
  });

  // Monitor config is stored under settings.testConfig to avoid
  // conflicting with registry settings (registryName, registryIcon, etc.)
  const rawSettings = query.data?.config?.settings;
  const savedMonitorConfig =
    rawSettings && typeof rawSettings === "object"
      ? ((rawSettings as Record<string, unknown>).testConfig as
          | Partial<RegistryMonitorConfig>
          | undefined)
      : undefined;

  // Also check for legacy flat keys (migrate automatically)
  const legacyMonitorMode = rawSettings
    ? ((rawSettings as Record<string, unknown>).monitorMode ??
      (rawSettings as Record<string, unknown>).testMode)
    : undefined;
  const hasLegacyKeys = typeof legacyMonitorMode === "string";

  const settings: RegistryMonitorConfig = {
    ...DEFAULT_MONITOR_SETTINGS,
    ...(savedMonitorConfig ?? {}),
    // Fallback: read legacy flat keys if testConfig namespace doesn't exist yet
    ...(hasLegacyKeys && !savedMonitorConfig
      ? (rawSettings as Partial<RegistryMonitorConfig>)
      : {}),
  };

  const saveMutation = useMutation({
    mutationFn: async (patch: Partial<RegistryMonitorConfig>) => {
      // Fetch the latest settings to avoid overwriting registry config
      const latestData = await callTool<PluginConfigResponse>(
        client,
        "VIRTUAL_MCP_PLUGIN_CONFIG_GET",
        {
          virtualMcpId: project.id,
          pluginId: PLUGIN_ID,
        },
      );
      const latestSettings =
        (latestData?.config?.settings as Record<string, unknown>) ?? {};

      return callTool<PluginConfigResponse>(
        client,
        "VIRTUAL_MCP_PLUGIN_CONFIG_UPDATE",
        {
          virtualMcpId: project.id,
          pluginId: PLUGIN_ID,
          settings: {
            ...latestSettings,
            // Store test config under a dedicated namespace
            testConfig: {
              ...DEFAULT_MONITOR_SETTINGS,
              ...((latestSettings.testConfig as
                | Partial<RegistryMonitorConfig>
                | undefined) ?? {}),
              ...patch,
            },
          },
        },
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: KEYS.registryConfigByPlugin(project.id ?? "", PLUGIN_ID),
      });
    },
  });

  return {
    settings,
    isLoading: query.isLoading,
    saveMutation,
  };
}

export function useMonitorScheduleSet() {
  const queryClient = useQueryClient();
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  return useMutation({
    mutationFn: async (args: {
      cronExpression: string;
      config?: Partial<RegistryMonitorConfig>;
    }) =>
      callTool<{ scheduleEventId: string }>(
        client,
        "REGISTRY_MONITOR_SCHEDULE_SET",
        args,
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: KEYS.registryConfig() });
    },
  });
}

export function useMonitorScheduleCancel() {
  const queryClient = useQueryClient();
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  return useMutation({
    mutationFn: async (scheduleEventId: string) =>
      callTool<{ success: boolean }>(
        client,
        "REGISTRY_MONITOR_SCHEDULE_CANCEL",
        {
          scheduleEventId,
        },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: KEYS.registryConfig() });
    },
  });
}

export function useBrokenMonitorsCount() {
  const runsQuery = useMonitorRuns("completed");
  const latestRunId = runsQuery.data?.items?.[0]?.id;
  const latestRunStatus = runsQuery.data?.items?.[0]?.status;
  const failedResultsQuery = useMonitorResults(
    latestRunId,
    "failed",
    latestRunStatus,
  );
  return {
    brokenCount: failedResultsQuery.data?.items?.length ?? 0,
    isLoading: runsQuery.isLoading || failedResultsQuery.isLoading,
  };
}
