import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useProjectContext, WellKnownOrgMCPId } from "@/sdk";
import { toast } from "sonner";
import { useStudioTools } from "@/lib/studio-tools";
import { KEYS } from "@/lib/registry/query-keys";
import type {
  PublishApiKeyGenerateResult,
  PublishApiKeyListResponse,
  PublishRequest,
  PublishRequestListResponse,
  PublishRequestStatus,
  RegistryBulkCreateResult,
  RegistryCreateInput,
  RegistryFilters,
  RegistryItem,
  RegistryListResponse,
  RegistryUpdateInput,
} from "@/lib/registry/types";

const DEFAULT_LIMIT = 24;

function normalizeSearch(search: string): string {
  return search.trim();
}

type StudioTools = ReturnType<typeof useStudioTools>;

async function callTool<T>(
  studio: StudioTools,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  return studio.call(
    name as Parameters<StudioTools["call"]>[0],
    args as Parameters<StudioTools["call"]>[1],
  ) as Promise<T>;
}

export function useRegistryItems(params: {
  search: string;
  tags: string[];
  categories: string[];
  limit?: number;
}) {
  const studio = useStudioTools();
  const search = normalizeSearch(params.search);
  const limit = params.limit ?? DEFAULT_LIMIT;

  return useInfiniteQuery({
    queryKey: KEYS.itemsList(search, params.tags, params.categories, limit),
    queryFn: async ({ pageParam }) => {
      const where =
        search.length > 0
          ? {
              operator: "or",
              conditions: [
                {
                  field: ["title"],
                  operator: "contains",
                  value: search,
                },
                {
                  field: ["description"],
                  operator: "contains",
                  value: search,
                },
                {
                  field: ["id"],
                  operator: "contains",
                  value: search,
                },
                {
                  field: ["server", "name"],
                  operator: "contains",
                  value: search,
                },
              ],
            }
          : undefined;

      return callTool<RegistryListResponse>(studio, "REGISTRY_ITEM_LIST", {
        cursor: pageParam as string | undefined,
        limit,
        tags: params.tags.length ? params.tags : undefined,
        categories: params.categories.length ? params.categories : undefined,
        where,
      });
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 30_000,
  });
}

export function useRegistryFilters() {
  const studio = useStudioTools();

  return useQuery({
    queryKey: KEYS.filters(),
    queryFn: async () =>
      callTool<RegistryFilters>(studio, "REGISTRY_ITEM_FILTERS", {}),
    placeholderData: { tags: [], categories: [] },
    staleTime: 60_000,
  });
}

export function useRegistryMutations() {
  const queryClient = useQueryClient();
  const studio = useStudioTools();

  const invalidateAll = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: KEYS.items() }),
      queryClient.invalidateQueries({ queryKey: KEYS.filters() }),
    ]);
  };

  const createMutation = useMutation({
    mutationFn: async (data: RegistryCreateInput) => {
      const response = await callTool<{ item: RegistryItem }>(
        studio,
        "REGISTRY_ITEM_CREATE",
        { data },
      );
      return response.item;
    },
    onSuccess: invalidateAll,
  });

  const updateMutation = useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: RegistryUpdateInput;
    }) => {
      const response = await callTool<{ item: RegistryItem }>(
        studio,
        "REGISTRY_ITEM_UPDATE",
        { id, data },
      );
      return response.item;
    },
    onSuccess: invalidateAll,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const response = await callTool<{ item: RegistryItem | null }>(
        studio,
        "REGISTRY_ITEM_DELETE",
        { id },
      );
      return response.item;
    },
    onSuccess: invalidateAll,
  });

  const bulkCreateMutation = useMutation({
    mutationFn: async (items: RegistryCreateInput[]) =>
      callTool<RegistryBulkCreateResult>(studio, "REGISTRY_ITEM_BULK_CREATE", {
        items,
      }),
    onSuccess: invalidateAll,
  });

  return {
    createMutation,
    updateMutation,
    deleteMutation,
    bulkCreateMutation,
  };
}

interface PluginConfigResponse {
  config: {
    settings: Record<string, unknown> | null;
  } | null;
}

interface RegistryConfigSettings {
  registryName?: string;
  registryIcon?: string;
  acceptPublishRequests?: boolean;
  requireApiToken?: boolean;
  storePrivateOnly?: boolean;
  rateLimitEnabled?: boolean;
  rateLimitWindow?: "minute" | "hour";
  rateLimitMax?: number;
}

export function useRegistryConfig(pluginId: string) {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();

  const selfConnectionId = WellKnownOrgMCPId.SELF(org.id);

  const configQuery = useQuery({
    queryKey: KEYS.registryConfigByPlugin(selfConnectionId, pluginId),
    queryFn: async () =>
      callTool<PluginConfigResponse>(studio, "VIRTUAL_MCP_PLUGIN_CONFIG_GET", {
        virtualMcpId: selfConnectionId,
        pluginId,
      }),
    staleTime: 60_000,
  });

  const queryKey = KEYS.registryConfigByPlugin(selfConnectionId, pluginId);

  const configMutation = useMutation({
    mutationFn: async (settingsPatch: RegistryConfigSettings) => {
      const latestData = await callTool<PluginConfigResponse>(
        studio,
        "VIRTUAL_MCP_PLUGIN_CONFIG_GET",
        {
          virtualMcpId: selfConnectionId,
          pluginId,
        },
      );
      const currentSettings =
        (latestData?.config?.settings as RegistryConfigSettings | null) ?? {};

      return callTool<PluginConfigResponse>(
        studio,
        "VIRTUAL_MCP_PLUGIN_CONFIG_UPDATE",
        {
          virtualMcpId: selfConnectionId,
          pluginId,
          settings: {
            ...currentSettings,
            ...settingsPatch,
          },
        },
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to save registry settings",
      );
    },
  });

  const updateConfig = (patch: RegistryConfigSettings) => {
    configMutation.mutate(patch);
  };

  const registryName =
    (configQuery.data?.config?.settings?.registryName as string | undefined) ??
    "Private Registry";
  const registryIcon =
    (configQuery.data?.config?.settings?.registryIcon as string | undefined) ??
    "";
  const acceptPublishRequests =
    (configQuery.data?.config?.settings?.acceptPublishRequests as
      | boolean
      | undefined) ?? false;

  const requireApiToken =
    (configQuery.data?.config?.settings?.requireApiToken as
      | boolean
      | undefined) ?? false;

  const storePrivateOnly =
    (configQuery.data?.config?.settings?.storePrivateOnly as
      | boolean
      | undefined) ?? false;

  const rateLimitEnabled =
    (configQuery.data?.config?.settings?.rateLimitEnabled as
      | boolean
      | undefined) ?? true;
  const rawRateLimitWindow = configQuery.data?.config?.settings
    ?.rateLimitWindow as string | undefined;
  const rateLimitWindow: "minute" | "hour" =
    rawRateLimitWindow === "minute" ? "minute" : "hour";
  const rawRateLimitMax = configQuery.data?.config?.settings?.rateLimitMax as
    | number
    | undefined;
  const rateLimitMax =
    typeof rawRateLimitMax === "number" && rawRateLimitMax >= 1
      ? Math.floor(rawRateLimitMax)
      : 100;

  return {
    registryName,
    registryIcon,
    acceptPublishRequests,
    requireApiToken,
    storePrivateOnly,
    rateLimitEnabled,
    rateLimitWindow,
    rateLimitMax,
    isLoadingConfig: configQuery.isLoading,
    isSaving: configMutation.isPending,
    updateConfig,
  };
}

export function usePublishRequests(params: {
  status?: PublishRequestStatus;
  sortBy: "created_at" | "title";
  sortDirection: "asc" | "desc";
}) {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const limit = DEFAULT_LIMIT;

  return useInfiniteQuery({
    queryKey: KEYS.publishRequestsListByOrg(
      org.id,
      params.status,
      params.sortBy,
      params.sortDirection,
    ),
    queryFn: async ({ pageParam }) =>
      callTool<PublishRequestListResponse>(
        studio,
        "REGISTRY_PUBLISH_REQUEST_LIST",
        {
          status: params.status,
          sortBy: params.sortBy,
          sortDirection: params.sortDirection,
          limit,
          offset: pageParam as number,
        },
      ),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loadedCount = allPages.reduce(
        (total, page) => total + page.items.length,
        0,
      );
      return loadedCount < lastPage.totalCount ? loadedCount : undefined;
    },
    staleTime: 30_000,
    refetchOnMount: true,
  });
}

export function usePublishRequestCount() {
  const { org } = useProjectContext();
  const studio = useStudioTools();

  return useQuery({
    queryKey: KEYS.publishRequestsCountByOrg(org.id),
    queryFn: async () =>
      callTool<{ pending: number }>(
        studio,
        "REGISTRY_PUBLISH_REQUEST_COUNT",
        {},
      ),
    staleTime: 30_000,
  });
}

export function usePublishRequestMutations() {
  const queryClient = useQueryClient();
  const studio = useStudioTools();

  const invalidateAll = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: KEYS.publishRequests() }),
    ]);
  };

  const reviewMutation = useMutation({
    mutationFn: async (data: {
      id: string;
      status: "approved" | "rejected";
      reviewerNotes?: string;
    }) => {
      return callTool<{ item: PublishRequest }>(
        studio,
        "REGISTRY_PUBLISH_REQUEST_REVIEW",
        data,
      );
    },
    onSuccess: invalidateAll,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      return callTool<{ item: PublishRequest | null }>(
        studio,
        "REGISTRY_PUBLISH_REQUEST_DELETE",
        { id },
      );
    },
    onSuccess: invalidateAll,
  });

  return { reviewMutation, deleteMutation };
}

// ─── Publish API Keys ───

export function usePublishApiKeys() {
  const studio = useStudioTools();

  return useQuery({
    queryKey: KEYS.publishApiKeys(),
    queryFn: async () =>
      callTool<PublishApiKeyListResponse>(
        studio,
        "REGISTRY_PUBLISH_API_KEY_LIST",
        {},
      ),
    staleTime: 30_000,
  });
}

export function usePublishApiKeyMutations() {
  const queryClient = useQueryClient();
  const studio = useStudioTools();

  const generateMutation = useMutation({
    mutationFn: async (name: string) =>
      callTool<PublishApiKeyGenerateResult>(
        studio,
        "REGISTRY_PUBLISH_API_KEY_GENERATE",
        { name },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: KEYS.publishApiKeys(),
      });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async (keyId: string) =>
      callTool<{ success: boolean; keyId: string }>(
        studio,
        "REGISTRY_PUBLISH_API_KEY_REVOKE",
        { keyId },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: KEYS.publishApiKeys(),
      });
    },
  });

  return { generateMutation, revokeMutation };
}
