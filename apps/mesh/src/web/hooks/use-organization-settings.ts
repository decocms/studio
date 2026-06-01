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
import { useRef } from "react";
import { KEYS } from "@/web/lib/query-keys";

export type { SimpleModeTier } from "@/tools/organization/schema";
import type { SimpleModeTier } from "@/tools/organization/schema";

export interface ModelSlot {
  keyId: string;
  modelId: string;
  title?: string;
}

export interface SimpleModeConfig {
  tiers: Record<SimpleModeTier, ModelSlot | null>;
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
  tiers: {
    fast: null,
    smart: null,
    thinking: null,
    image: null,
    web_research: null,
  },
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
  if (!cfg?.tiers) return EMPTY_SIMPLE_MODE;
  return {
    tiers: {
      fast: cfg.tiers.fast ?? null,
      smart: cfg.tiers.smart ?? null,
      thinking: cfg.tiers.thinking ?? null,
      image: cfg.tiers.image ?? null,
      web_research: cfg.tiers.web_research ?? null,
    },
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

export interface HomeAgentsWriter {
  /** The freshest id list, read live from the cache (not a render snapshot). */
  currentIds: () => string[];
  /**
   * Queue a write. `transform` receives the freshest id list and returns the
   * next one, or `null` to skip (no-op guards like "already on home").
   */
  apply: (transform: (ids: string[]) => string[] | null) => Promise<void>;
}

/**
 * Serialized, optimistic writer for `default_home_agents`.
 *
 * Both the home board and the manage-home drawer mutate this same ordered list,
 * often via rapid clicks (add / remove / reorder). Three guarantees keep that
 * safe — and are why callers must go through here instead of touching the cache
 * and mutation directly:
 *  - each write derives its next id list from the *live* cache, never a
 *    render-time snapshot, so concurrent edits can't clobber each other;
 *  - writes run strictly in order (a per-instance promise chain), so two
 *    in-flight requests can't reach the server out of order and commit stale ids;
 *  - the cache is patched optimistically and rolled back if the write fails.
 */
export function useHomeAgentsWriter(): HomeAgentsWriter {
  const { org } = useProjectContext();
  const update = useUpdateDefaultHomeAgents();
  const queryClient = useQueryClient();
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const key = KEYS.organizationSettings(org.id);

  const currentIds = (): string[] =>
    queryClient.getQueryData<OrganizationSettings>(key)?.default_home_agents
      ?.ids ?? [];

  const apply = (
    transform: (ids: string[]) => string[] | null,
  ): Promise<void> => {
    const run = chain.current.then(async () => {
      const snapshot = queryClient.getQueryData<OrganizationSettings>(key);
      const next = transform(snapshot?.default_home_agents?.ids ?? []);
      if (next === null) return;
      queryClient.setQueryData<OrganizationSettings | undefined>(key, (prev) =>
        prev ? { ...prev, default_home_agents: { ids: next } } : prev,
      );
      try {
        await update.mutateAsync({ ids: next });
        await queryClient.refetchQueries({
          queryKey: KEYS.homeNextActions(org.slug),
          type: "active",
        });
      } catch (err) {
        queryClient.setQueryData(key, snapshot);
        throw err;
      }
    });
    // Keep the chain alive even when a write rejects, so later writes still run.
    chain.current = run.catch(() => {});
    return run;
  };

  return { currentIds, apply };
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
