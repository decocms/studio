import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
  WellKnownOrgMCPId,
} from "@decocms/mesh-sdk";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
  type MutateOptions,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";

export interface ModelSlot {
  keyId: string;
  modelId: string;
  title?: string;
}

export interface SimpleModeConfig {
  enabled: boolean;
  chat: {
    fast: ModelSlot | null;
    smart: ModelSlot | null;
    thinking: ModelSlot | null;
  };
  image: ModelSlot | null;
  webResearch: ModelSlot | null;
}

export interface RegistryConfig {
  registries: Record<string, { enabled: boolean }>;
  blockedMcps: string[];
}

export interface DefaultHomeAgentsConfig {
  ids: string[];
}

export interface OrganizationSettings {
  organizationId: string;
  sidebar_items: unknown[] | null;
  enabled_plugins: string[] | null;
  registry_config: RegistryConfig | null;
  simple_mode: SimpleModeConfig | null;
  default_home_agents: DefaultHomeAgentsConfig | null;
  createdAt?: string;
  updatedAt?: string;
}

const EMPTY_SETTINGS: OrganizationSettings = {
  organizationId: "",
  sidebar_items: null,
  enabled_plugins: null,
  registry_config: null,
  simple_mode: null,
  default_home_agents: null,
};

const EMPTY_SIMPLE_MODE: SimpleModeConfig = {
  enabled: false,
  chat: { fast: null, smart: null, thinking: null },
  image: null,
  webResearch: null,
};

/**
 * Core query hook over the single shared `organization_settings` row.
 * Callers pass a `select` fn to derive just the slice they care about.
 * Not exported — use a named wrapper (useSimpleMode, useRegistryConfig, …).
 */
function useOrganizationSettings<T = OrganizationSettings>(
  select?: (settings: OrganizationSettings) => T,
): UseQueryResult<T> {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  return useQuery({
    queryKey: KEYS.organizationSettings(org.id),
    queryFn: async () => {
      const result = (await client.callTool({
        name: "ORGANIZATION_SETTINGS_GET",
        arguments: {},
      })) as { structuredContent?: OrganizationSettings; isError?: boolean };
      if (result?.isError) {
        return { ...EMPTY_SETTINGS, organizationId: org.id };
      }
      return (
        result.structuredContent ?? {
          ...EMPTY_SETTINGS,
          organizationId: org.id,
        }
      );
    },
    staleTime: 60_000,
    select: select as (data: OrganizationSettings) => T,
  });
}

/**
 * Suspense variant used by shell-layout, which mounts ProjectContextProvider
 * and therefore can't call useProjectContext() yet — so it passes `orgId`
 * explicitly. Same query key as the non-suspense variant — shares the cache.
 */
export function useOrganizationSettingsSuspense(
  orgId: string,
  orgSlug: string,
): OrganizationSettings {
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId,
    orgSlug,
  });

  const { data } = useSuspenseQuery({
    queryKey: KEYS.organizationSettings(orgId),
    queryFn: async () => {
      const result = (await client.callTool({
        name: "ORGANIZATION_SETTINGS_GET",
        arguments: {},
      })) as { structuredContent?: OrganizationSettings; isError?: boolean };
      if (result?.isError) {
        return { ...EMPTY_SETTINGS, organizationId: orgId };
      }
      return (
        result.structuredContent ?? { ...EMPTY_SETTINGS, organizationId: orgId }
      );
    },
    staleTime: 60_000,
  });

  return data;
}

type OrgSettingsUpdateInput = Partial<
  Pick<
    OrganizationSettings,
    | "sidebar_items"
    | "enabled_plugins"
    | "registry_config"
    | "simple_mode"
    | "default_home_agents"
  >
>;

type ToolErrorEnvelope = {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
};

/**
 * Core mutation hook. Accepts any subset of updatable org-settings fields.
 * On success, writes the full returned row into the shared cache entry so
 * every consumer sees fresh data without a refetch.
 */
export function useUpdateOrganizationSettings(): UseMutationResult<
  OrganizationSettings,
  Error,
  OrgSettingsUpdateInput
> {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: OrgSettingsUpdateInput) => {
      const result = (await client.callTool({
        name: "ORGANIZATION_SETTINGS_UPDATE",
        arguments: {
          organizationId: org.id,
          ...input,
        },
      })) as {
        structuredContent?: OrganizationSettings;
      } & ToolErrorEnvelope;
      if (result?.isError) {
        throw new Error(
          result.content?.[0]?.text ?? "Failed to update organization settings",
        );
      }
      const payload = result.structuredContent;
      if (!payload) {
        throw new Error("ORGANIZATION_SETTINGS_UPDATE returned no payload");
      }
      return payload;
    },
    onSuccess: (payload) => {
      queryClient.setQueryData(
        KEYS.organizationSettings(org.id),
        (prev: OrganizationSettings | undefined) => ({
          ...(prev ?? EMPTY_SETTINGS),
          ...payload,
        }),
      );
    },
  });
}

// ---------------------------------------------------------------------------
// Thin named wrappers — one per slice of organization settings currently
// consumed by the React tree. Share the same query key and cache entry.
// ---------------------------------------------------------------------------

function normalizeSimpleMode(cfg: SimpleModeConfig | null): SimpleModeConfig {
  if (!cfg) return EMPTY_SIMPLE_MODE;
  return {
    enabled: cfg.enabled ?? false,
    chat: {
      fast: cfg.chat?.fast ?? null,
      smart: cfg.chat?.smart ?? null,
      thinking: cfg.chat?.thinking ?? null,
    },
    image: cfg.image ?? null,
    webResearch: cfg.webResearch ?? null,
  };
}

export function useSimpleMode(): SimpleModeConfig {
  const { data } = useOrganizationSettings((s) =>
    normalizeSimpleMode(s.simple_mode),
  );
  return data ?? EMPTY_SIMPLE_MODE;
}

type OrgSettingsMutateOptions = MutateOptions<
  OrganizationSettings,
  Error,
  OrgSettingsUpdateInput
>;

export function useUpdateSimpleMode() {
  const mutation = useUpdateOrganizationSettings();
  return {
    ...mutation,
    mutate: (config: SimpleModeConfig, options?: OrgSettingsMutateOptions) =>
      mutation.mutate({ simple_mode: config }, options),
    mutateAsync: (
      config: SimpleModeConfig,
      options?: OrgSettingsMutateOptions,
    ) => mutation.mutateAsync({ simple_mode: config }, options),
  };
}

export function useRegistryConfig(): RegistryConfig | null {
  const { data } = useOrganizationSettings((s) => s.registry_config);
  return data ?? null;
}

export function useUpdateRegistryConfig() {
  const mutation = useUpdateOrganizationSettings();
  return {
    ...mutation,
    mutate: (config: RegistryConfig, options?: OrgSettingsMutateOptions) =>
      mutation.mutate({ registry_config: config }, options),
    mutateAsync: (config: RegistryConfig, options?: OrgSettingsMutateOptions) =>
      mutation.mutateAsync({ registry_config: config }, options),
  };
}

/**
 * Returns a predicate that tells whether a given connectionId is an enabled
 * registry. Falls back to "Deco Store is the default" when no registry_config
 * is set.
 */
export function useDefaultHomeAgents(): DefaultHomeAgentsConfig | null {
  const { data } = useOrganizationSettings((s) => s.default_home_agents);
  return data ?? null;
}

export function useUpdateDefaultHomeAgents() {
  const mutation = useUpdateOrganizationSettings();
  return {
    ...mutation,
    mutate: (
      config: DefaultHomeAgentsConfig,
      options?: OrgSettingsMutateOptions,
    ) => mutation.mutate({ default_home_agents: config }, options),
    mutateAsync: (
      config: DefaultHomeAgentsConfig,
      options?: OrgSettingsMutateOptions,
    ) => mutation.mutateAsync({ default_home_agents: config }, options),
  };
}

export function useIsRegistryEnabled(): (connectionId: string) => boolean {
  const { org } = useProjectContext();
  const registryConfig = useRegistryConfig();
  const decoStoreId = WellKnownOrgMCPId.REGISTRY(org.id);

  return (connectionId: string): boolean => {
    if (!registryConfig) return connectionId === decoStoreId;
    const entry = registryConfig.registries[connectionId];
    if (!entry) return connectionId === decoStoreId;
    return entry.enabled;
  };
}
