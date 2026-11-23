/**
 * The store diagnosis behind Plan. `PLAN_DIAGNOSIS_STATUS` is a Studio tool;
 * everything else calls the org's engine connection, and stays disabled until
 * the status says it is configured. Engine answers go through
 * `diagnosis-schema.ts`, so the page sees `{ ok: false, error }` for anything
 * it cannot read.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import {
  mcpClientQueryOptions,
  useProjectContext,
  WellKnownOrgMCPId,
} from "@/sdk";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import {
  DecideHypothesisSchema,
  GetOpportunitySchema,
  type PageType,
  type ParsedToolResult,
  StartRunSchema,
  StoreViewSchema,
  parseToolResult,
  storeViewRefetchInterval,
  toolPayload,
} from "./diagnosis-schema.ts";

type EngineTool =
  | "get_ux_store_view"
  | "get_ux_opportunity"
  | "start_ux_diagnosis"
  | "update_ux_hypothesis_status";

export function usePlanDiagnosisStatus(): {
  configured: boolean;
  reason?: string;
  isLoading: boolean;
} {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const { data, isLoading } = useQuery({
    queryKey: KEYS.planDiagnosisStatus(org.id),
    staleTime: 60_000,
    queryFn: () => studio.call("PLAN_DIAGNOSIS_STATUS", {}),
  });
  return {
    configured: data?.configured ?? false,
    reason: data?.reason,
    isLoading,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : String(error);
}

function valueOf<T>(result: ParsedToolResult<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function useEngine() {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const { configured } = usePlanDiagnosisStatus();
  const connectionId = WellKnownOrgMCPId.PLAN_DIAGNOSIS(org.id);

  /** A failed connect or call is the same `{ ok: false }` as an engine error. */
  const call = async <T>(
    schema: z.ZodType<T>,
    name: EngineTool,
    args: Record<string, unknown>,
  ): Promise<ParsedToolResult<T>> => {
    try {
      const client = await queryClient.fetchQuery(
        mcpClientQueryOptions({
          connectionId,
          orgId: org.id,
          orgSlug: org.slug,
        }),
      );
      const result = await client.callTool({ name, arguments: args });
      return parseToolResult(schema, toolPayload(result));
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  };

  return { orgId: org.id, connectionId, configured, call, queryClient };
}

/** The store at a glance for a goal's runs (`null` = every run). Polls only
 *  while a page is running. */
export function useStoreView(goalId: string | null) {
  const engine = useEngine();
  return useQuery({
    queryKey: KEYS.planStoreView(engine.orgId, goalId, engine.connectionId),
    enabled: engine.configured,
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
    queryKey: KEYS.planOpportunity(engine.orgId, id, engine.connectionId),
    enabled: engine.configured && id !== "",
    retry: 1,
    queryFn: async () =>
      valueOf(
        await engine.call(GetOpportunitySchema, "get_ux_opportunity", {
          opportunity_id: id,
        }),
      ).opportunity,
  });
}

export interface StartRunInput {
  pages?: PageType[];
  todas?: boolean;
  goal_id?: string;
  objective_statement?: string;
}

export function useStartRun() {
  const engine = useEngine();
  return useMutation({
    mutationFn: async (input: StartRunInput) =>
      valueOf(
        await engine.call(StartRunSchema, "start_ux_diagnosis", { ...input }),
      ),
    onSettled: () =>
      engine.queryClient.invalidateQueries({
        queryKey: KEYS.planStoreViews(engine.orgId),
      }),
  });
}

export interface DecideHypothesisInput {
  hypothesis_id: string;
  status: "approved" | "dismissed";
  note?: string;
}

export function useDecideHypothesis() {
  const engine = useEngine();
  return useMutation({
    mutationFn: async (input: DecideHypothesisInput) =>
      valueOf(
        await engine.call(
          DecideHypothesisSchema,
          "update_ux_hypothesis_status",
          { ...input },
        ),
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
