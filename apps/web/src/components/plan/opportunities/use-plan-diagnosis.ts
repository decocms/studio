/**
 * The store diagnosis behind Plan. `PLAN_DIAGNOSIS_STATUS` is a Studio tool;
 * everything else calls the engine, and stays disabled until the status says
 * it is configured. With `plan_engine_native` the engine is Studio's own
 * `PLAN_UX_*` tools; otherwise the org's engine connection. Either way the
 * answers go through `diagnosis-schema.ts`; anything the page cannot read
 * throws a `DiagnosisEngineError`, so React Query keeps the last good data.
 */

import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { z } from "zod";
import type { StudioToolInput } from "@decocms/shared/tools/tool-io";
import { mcpClientQueryOptions, useProjectContext } from "@/sdk";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import {
  DecideHypothesisSchema,
  GetOpportunitySchema,
  SiteProfileSchema,
  type StartRunInput,
  StartRunSchema,
  StoreViewSchema,
  UpdateProfileSchema,
  parseToolResult,
  toolPayload,
} from "./diagnosis-schema.ts";
import {
  type DiagnosisStatusState,
  diagnosisStatusState,
  type EngineArgs,
  type EngineTool,
  engineScope,
  engineTargetOf,
  NATIVE_ENGINE_TOOL,
  retryEngineRead,
  storeViewEnabled,
  storeViewRefetchInterval,
  unwrapEngineResult,
} from "./diagnosis-state.ts";

/** The status names the engine, so the page never reads the org's flags
 *  itself and engine reads start only on the one the server chose. */
export function usePlanDiagnosisStatus(): DiagnosisStatusState {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const query = useQuery({
    queryKey: KEYS.planDiagnosisStatus(org.id),
    staleTime: 60_000,
    queryFn: () => studio.call("PLAN_DIAGNOSIS_STATUS", {}),
  });
  return diagnosisStatusState(query, () => void query.refetch());
}

/** Binds the engine to a BigQuery connection and GA4 dataset, then rereads
 *  the status so the section moves on to the store view. */
export function useDiagnosisSetup() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: StudioToolInput<"PLAN_DIAGNOSIS_SETUP">) =>
      studio.call("PLAN_DIAGNOSIS_SETUP", input),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: KEYS.planDiagnosisStatus(org.id),
      }),
  });
}

function useEngine() {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const studio = useStudioTools();
  const target = engineTargetOf(usePlanDiagnosisStatus());

  /** The engine's answer as the tool returned it. */
  const answer = async <E extends EngineTool>(
    name: E,
    args: EngineArgs<E>,
  ): Promise<unknown> => {
    if (!target) {
      throw new Error("The store diagnosis is not configured");
    }
    if (target.kind === "native") {
      return studio.call(NATIVE_ENGINE_TOOL[name], args);
    }
    const client = await queryClient.fetchQuery(
      mcpClientQueryOptions({
        connectionId: target.connectionId,
        orgId: org.id,
        orgSlug: org.slug,
      }),
    );
    return toolPayload(await client.callTool({ name, arguments: args }));
  };

  /** Throws `DiagnosisEngineError` for an engine error or an unreadable answer;
   *  a failed connect or transport error propagates as is. */
  const call = async <T, E extends EngineTool>(
    schema: z.ZodType<T>,
    name: E,
    args: EngineArgs<E>,
  ): Promise<T> =>
    unwrapEngineResult(parseToolResult(schema, await answer(name, args)));

  return {
    orgId: org.id,
    target,
    scope: engineScope(target),
    call,
    queryClient,
  };
}

/** The store at a glance for a goal's runs (a null id = every run), off
 *  while the goals load. Polls while the last good view says a page is
 *  running. */
export function useStoreView(goal: { id: string | null; pending: boolean }) {
  const engine = useEngine();
  return useQuery({
    queryKey: KEYS.planStoreView(engine.orgId, goal.id, engine.scope),
    enabled: storeViewEnabled(engine.target, goal),
    retry: retryEngineRead,
    queryFn: () =>
      engine.call(
        StoreViewSchema,
        "get_ux_store_view",
        goal.id ? { goal_id: goal.id } : {},
      ),
    refetchInterval: (query) => storeViewRefetchInterval(query.state.data),
  });
}

type Engine = ReturnType<typeof useEngine>;

/** One query entry per loss, shared by its page and by the cards that fetch
 *  it before starting a case. */
function opportunityQuery(engine: Engine, id: string) {
  return {
    queryKey: KEYS.planOpportunity(engine.orgId, id, engine.scope),
    retry: retryEngineRead,
    queryFn: async () =>
      (
        await engine.call(GetOpportunitySchema, "get_ux_opportunity", {
          opportunity_id: id,
        })
      ).opportunity,
  };
}

export function useOpportunity(id: string) {
  const engine = useEngine();
  return useQuery({
    ...opportunityQuery(engine, id),
    enabled: engine.target !== null && id !== "",
  });
}

/** Reads a loss through the same cache entry as its page; a copy fetched in
 *  the last 30 s is reused. */
export function useFetchOpportunity() {
  const engine = useEngine();
  return (id: string) =>
    engine.queryClient.fetchQuery({
      ...opportunityQuery(engine, id),
      staleTime: 30_000,
    });
}

/** Rejects with `DiagnosisEngineError`; `needsDomain` is set when the store
 *  has no domain yet. */
export function useStartRun() {
  const engine = useEngine();
  return useMutation({
    mutationFn: (input: StartRunInput) =>
      engine.call(StartRunSchema, "start_ux_diagnosis", { ...input }),
    // A run can fill the store's profile from its site in Studio.
    onSettled: () =>
      Promise.all([
        engine.queryClient.invalidateQueries({
          queryKey: KEYS.planStoreViews(engine.orgId),
        }),
        engine.queryClient.invalidateQueries({
          queryKey: KEYS.planSiteProfiles(engine.orgId),
        }),
      ]),
  });
}

/** The store the engine analyses; null until its domain is known. Off
 *  when the store view already carries it. */
export function useSiteProfile({ enabled = true } = {}) {
  const engine = useEngine();
  return useQuery({
    queryKey: KEYS.planSiteProfile(engine.orgId, engine.scope),
    enabled: enabled && engine.target !== null,
    retry: retryEngineRead,
    queryFn: async () =>
      (await engine.call(SiteProfileSchema, "get_ux_site_profile", {})).profile,
  });
}

/** Sets the store's domain. Rejects with the engine's message, such as an
 *  invalid domain. */
export function useUpdateStoreDomain() {
  const engine = useEngine();
  return useMutation({
    mutationFn: async (domain: string) =>
      (
        await engine.call(SiteProfileSchema, "update_ux_site_profile", {
          domain,
        })
      ).profile,
    onSettled: () => invalidateSetup(engine),
  });
}

/** The view's setup needs are read from the profile, so both refetch. */
function invalidateSetup(engine: Engine) {
  return Promise.all([
    engine.queryClient.invalidateQueries({
      queryKey: KEYS.planSiteProfiles(engine.orgId),
    }),
    engine.queryClient.invalidateQueries({
      queryKey: KEYS.planStoreViews(engine.orgId),
    }),
  ]);
}

const competitorsMutationKey = (orgId: string) =>
  [...KEYS.planSiteProfiles(orgId), "competitors"] as const;

/** Saves and confirms the competitors list, sent normalized. Rejects with a
 *  `DiagnosisEngineError` whose `rejected` names each domain that did not
 *  answer; then nothing is saved. */
export function useUpdateCompetitors() {
  const engine = useEngine();
  return useMutation({
    mutationKey: competitorsMutationKey(engine.orgId),
    mutationFn: (competitors: string[]) =>
      engine.call(UpdateProfileSchema, "update_ux_site_profile", {
        competitors,
      }),
    onSettled: () => invalidateSetup(engine),
  });
}

/** The competitors the last save kept without checking. Read from the
 *  mutation cache: the form that saved is gone once its need is met. */
export function useCompetitorWarnings() {
  const { org } = useProjectContext();
  const saves = useMutationState({
    filters: { mutationKey: competitorsMutationKey(org.id) },
    select: (mutation) => mutation.state,
  });
  const last = saves.at(-1);
  return last?.status === "success"
    ? (UpdateProfileSchema.safeParse(last.data).data?.warnings ?? [])
    : [];
}

/** `pending` undoes an earlier decision. */
export interface DecideHypothesisInput {
  hypothesis_id: string;
  status: "pending" | "approved" | "dismissed";
  note?: string;
}

export function useDecideHypothesis() {
  const engine = useEngine();
  return useMutation({
    mutationFn: async (input: DecideHypothesisInput) =>
      (
        await engine.call(
          DecideHypothesisSchema,
          "update_ux_hypothesis_status",
          { ...input },
        )
      ).hypothesis,
    onSettled: () =>
      Promise.all([
        engine.queryClient.invalidateQueries({
          queryKey: KEYS.planOpportunities(engine.orgId),
        }),
        engine.queryClient.invalidateQueries({
          queryKey: KEYS.planStoreViews(engine.orgId),
        }),
      ]),
  });
}
