import { useProjectContext, WellKnownOrgMCPId } from "@/sdk";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type MutateOptions,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useRef } from "react";
import { KEYS } from "@/lib/query-keys";
import { callStudioTool, useStudioTools } from "@/lib/studio-tools";
import type { StudioToolInput as ToolInput } from "@decocms/shared/tools/tool-io";

export type { SimpleModeTier } from "@decocms/shared/organization/schema";
import {
  DEFAULT_ON_FLAGS,
  orgFlagEnabled,
} from "@decocms/shared/organization/schema";
import type {
  OrgFlags,
  SimpleModeTier,
} from "@decocms/shared/organization/schema";

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
  flags: OrgFlags | null;
  main_agent_id: string | null;
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
  flags: null,
  main_agent_id: null,
};

const EMPTY_SIMPLE_MODE: SimpleModeConfig = {
  tiers: {
    fast: null,
    smart: null,
    thinking: null,
    image: null,
    web_search: null,
    deep_research: null,
  },
};

/**
 * Query options for the shared org-settings row. Shared by both the suspense
 * and non-suspense hooks below and by parallel-prefetch batches, so all callers
 * build the same query key + queryFn and read one cache entry.
 */
function organizationSettingsQueryOptions(orgSlug: string, orgId: string) {
  return {
    queryKey: KEYS.organizationSettings(orgId),
    queryFn: async (): Promise<OrganizationSettings> => {
      // GET is best-effort: a failed read falls back to empty settings rather
      // than erroring the shell/home (the REST client throws on non-2xx).
      try {
        return (await callStudioTool(
          orgSlug,
          "ORGANIZATION_SETTINGS_GET",
          {},
        )) as OrganizationSettings;
      } catch {
        return { ...EMPTY_SETTINGS, organizationId: orgId };
      }
    },
    staleTime: 60_000,
  };
}

/**
 * Core query hook over the single shared `organization_settings` row.
 * Callers pass a `select` fn to derive just the slice they care about.
 * Not exported — use a named wrapper (useSimpleMode, useRegistryConfig, …).
 */
function useOrganizationSettings<T = OrganizationSettings>(
  select?: (settings: OrganizationSettings) => T,
): UseQueryResult<T> {
  const { org } = useProjectContext();

  return useQuery({
    ...organizationSettingsQueryOptions(org.slug, org.id),
    select: select as (data: OrganizationSettings) => T,
  });
}

/**
 * Non-blocking shell read. Used by shell-layout, which mounts
 * ProjectContextProvider and therefore can't call useProjectContext() yet — so
 * it passes `orgId`/`orgSlug` explicitly. Same query key as the other variants.
 *
 * Deliberately non-suspense: the shell must NOT block its whole subtree
 * (sidebar, home, tiles) on the org-settings round-trip. `enabled_plugins` is
 * the only field consumed downstream and every consumer is null-safe, so we
 * render immediately with `null` and let the value fill in when the query
 * resolves.
 */
export function useOrganizationSettingsNonBlocking(
  orgId: string,
  orgSlug: string,
): OrganizationSettings | null {
  const { data } = useQuery(organizationSettingsQueryOptions(orgSlug, orgId));

  return data ?? null;
}

type OrgSettingsUpdateInput = Partial<
  Pick<
    OrganizationSettings,
    | "sidebar_items"
    | "enabled_plugins"
    | "registry_config"
    | "simple_mode"
    | "default_home_agents"
    | "flags"
    | "main_agent_id"
  >
>;

/**
 * Core mutation hook. Accepts any subset of updatable org-settings fields.
 * On success, writes the full returned row into the shared cache entry so
 * every consumer sees fresh data without a refetch. Module-local — consumed by
 * the field-specific hooks below.
 */
function useUpdateOrganizationSettings(): UseMutationResult<
  OrganizationSettings,
  Error,
  OrgSettingsUpdateInput
> {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: OrgSettingsUpdateInput) => {
      // Throws on non-2xx (validation/auth/etc.) — no silent false success.
      const payload = (await studio.call("ORGANIZATION_SETTINGS_UPDATE", {
        organizationId: org.id,
        ...input,
      } as ToolInput<"ORGANIZATION_SETTINGS_UPDATE">)) as OrganizationSettings;
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
      web_search: cfg.tiers.web_search ?? null,
      deep_research: cfg.tiers.deep_research ?? null,
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

/**
 * Whether the org uses the curated commerce (reports) look: the full Studio
 * shell stays, but agent navigation, the home Customize button, and the
 * Settings / Automations tabs are hidden. Non-blocking read — used for cosmetic
 * gating where a brief pre-resolution render is harmless.
 */
export function useReportsOnly(): boolean {
  return useOrgFlag("reports_only");
}

/**
 * Whether the org uses the first-class navigation: the sidebar lists
 * destinations (Reports / Library / Tasks) instead of chat threads, and the
 * thread list moves into a menu at the top of the chat panel.
 *
 * Unset means an org created before NEW_ORG_DEFAULT_FLAGS seeded this on; those
 * fall back to reports-only. Raw tri-state read, not `useOrgFlag`, so an explicit
 * `false` wins and one flag's default can depend on another's.
 */
export function useNavV2(): boolean {
  const { data } = useOrganizationSettings(
    (s) => s.flags?.nav_v2 ?? s.flags?.reports_only ?? false,
  );
  return data ?? false;
}

/**
 * Read one org flag from the `flags` bag via `orgFlagEnabled` (see
 * OrgFlagsSchema / DEFAULT_ON_FLAGS in @decocms/shared/organization/schema —
 * the single place flag defaults are defined). The pre-load fallback uses the
 * same default. Non-blocking, cosmetic-gating only.
 */
export function useOrgFlag(flag: keyof OrgFlags): boolean {
  const { data } = useOrganizationSettings((s) =>
    orgFlagEnabled(s.flags, flag),
  );
  return data ?? DEFAULT_ON_FLAGS.has(flag);
}

/**
 * Writer for a single org flag. Updates shallow-merge server-side, so writing
 * one flag never disturbs its neighbors in the `flags` bag.
 */
export function useSetOrgFlag() {
  const mutation = useUpdateOrganizationSettings();
  return {
    ...mutation,
    mutate: (
      flag: keyof OrgFlags,
      value: boolean,
      options?: OrgSettingsMutateOptions,
    ) => mutation.mutate({ flags: { [flag]: value } }, options),
    mutateAsync: (
      flag: keyof OrgFlags,
      value: boolean,
      options?: OrgSettingsMutateOptions,
    ) => mutation.mutateAsync({ flags: { [flag]: value } }, options),
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

function useUpdateDefaultHomeAgents() {
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

/**
 * The org's "main agent" — the virtual MCP id the org lands on (`/$org`)
 * instead of the Super Agent, or null when unset. `isPending` lets the landing
 * resolver wait for the first read so it doesn't flash the Super Agent then
 * redirect. Once the shell prefetches org settings, reads resolve from cache.
 */
export function useMainAgentId(): {
  mainAgentId: string | null;
  isPending: boolean;
} {
  const { data, isPending } = useOrganizationSettings(
    (s) => s.main_agent_id ?? null,
  );
  return { mainAgentId: data ?? null, isPending };
}

/**
 * Writer for the org's main agent. Pass a virtual MCP id to set it, or null to
 * clear (fall back to the Super Agent). Org-scoped: applies to every member.
 */
export function useSetMainAgent() {
  const mutation = useUpdateOrganizationSettings();
  return {
    ...mutation,
    mutate: (id: string | null, options?: OrgSettingsMutateOptions) =>
      mutation.mutate({ main_agent_id: id }, options),
    mutateAsync: (id: string | null, options?: OrgSettingsMutateOptions) =>
      mutation.mutateAsync({ main_agent_id: id }, options),
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
