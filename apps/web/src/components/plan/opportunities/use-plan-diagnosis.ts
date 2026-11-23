/**
 * The store diagnosis behind Plan. `PLAN_DIAGNOSIS_STATUS` is a Studio tool;
 * everything else calls the org's engine connection, and stays disabled until
 * the status says it is configured. Engine answers go through
 * `diagnosis-schema.ts`; anything the page cannot read throws a
 * `DiagnosisEngineError`, so React Query keeps the last good data.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import type { StudioToolInput } from "@decocms/shared/tools/tool-io";
import { mcpClientQueryOptions, useProjectContext } from "@/sdk";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import {
  DecideHypothesisSchema,
  GetOpportunitySchema,
  type PageType,
  StartRunSchema,
  StoreViewSchema,
  parseToolResult,
  toolPayload,
} from "./diagnosis-schema.ts";
import {
  type DiagnosisStatusState,
  diagnosisStatusState,
  engineConnectionOf,
  retryEngineRead,
  storeViewRefetchInterval,
  unwrapEngineResult,
} from "./diagnosis-state.ts";

type EngineTool =
  | "get_ux_store_view"
  | "get_ux_opportunity"
  | "start_ux_diagnosis"
  | "update_ux_hypothesis_status";

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
  const connectionId = engineConnectionOf(usePlanDiagnosisStatus());

  /** Throws `DiagnosisEngineError` for an engine error or an unreadable answer;
   *  a failed connect or transport error propagates as is. */
  const call = async <T>(
    schema: z.ZodType<T>,
    name: EngineTool,
    args: Record<string, unknown>,
  ): Promise<T> => {
    if (!connectionId) {
      throw new Error("The store diagnosis is not configured");
    }
    const client = await queryClient.fetchQuery(
      mcpClientQueryOptions({ connectionId, orgId: org.id, orgSlug: org.slug }),
    );
    const result = await client.callTool({ name, arguments: args });
    return unwrapEngineResult(parseToolResult(schema, toolPayload(result)));
  };

  return { orgId: org.id, connectionId, call, queryClient };
}

/** The store at a glance for a goal's runs (`null` = every run). Polls while
 *  the last good view says a page is running. */
export function useStoreView(goalId: string | null) {
  const engine = useEngine();
  return useQuery({
    queryKey: KEYS.planStoreView(
      engine.orgId,
      goalId,
      engine.connectionId ?? "",
    ),
    enabled: engine.connectionId !== null,
    retry: retryEngineRead,
    queryFn: () =>
      engine.call(
        StoreViewSchema,
        "get_ux_store_view",
        goalId ? { goal_id: goalId } : {},
      ),
    refetchInterval: (query) => storeViewRefetchInterval(query.state.data),
  });
}

export function useOpportunity(id: string) {
  const engine = useEngine();
  return useQuery({
    queryKey: KEYS.planOpportunity(engine.orgId, id, engine.connectionId ?? ""),
    enabled: engine.connectionId !== null && id !== "",
    retry: retryEngineRead,
    queryFn: async () =>
      (
        await engine.call(GetOpportunitySchema, "get_ux_opportunity", {
          opportunity_id: id,
        })
      ).opportunity,
  });
}

export interface StartRunInput {
  pages?: PageType[];
  todas?: boolean;
  goal_id?: string;
  objective_statement?: string;
}

/** Rejects with `DiagnosisEngineError`; `needsDomain` is set when the store
 *  has no domain yet. */
export function useStartRun() {
  const engine = useEngine();
  return useMutation({
    mutationFn: (input: StartRunInput) =>
      engine.call(StartRunSchema, "start_ux_diagnosis", { ...input }),
    onSettled: () =>
      engine.queryClient.invalidateQueries({
        queryKey: KEYS.planStoreViews(engine.orgId),
      }),
  });
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
