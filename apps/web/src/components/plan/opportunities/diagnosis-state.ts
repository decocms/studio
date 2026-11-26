/**
 * The pure decisions behind `use-plan-diagnosis.ts`: what the status read
 * means for the page, where engine calls go, when engine reads run, retry
 * and poll, and how an engine refusal surfaces as an error.
 */

import type {
  StudioToolInput,
  StudioToolName,
  StudioToolOutput,
} from "@decocms/shared/tools/tool-io";
import type {
  CompetitorRejection,
  ParsedToolResult,
  SetupNeed,
  StoreView,
} from "./diagnosis-schema.ts";

type StatusOutput = StudioToolOutput<"PLAN_DIAGNOSIS_STATUS">;
type UnconfiguredReason = NonNullable<StatusOutput["reason"]>;

/** Where engine calls go: Studio's own tools (`plan_engine_native`), or the org's external engine connection. */
export type EngineTarget =
  | { kind: "native" }
  | { kind: "connection"; connectionId: string };

export type DiagnosisStatusState =
  | { state: "loading" }
  | { state: "error"; error: string; retry: () => void }
  | { state: "unconfigured"; reason: UnconfiguredReason }
  | { state: "configured"; target: EngineTarget };

/** Each engine tool the page calls and the Studio tool that answers it with `plan_engine_native` on. */
export const NATIVE_ENGINE_TOOL = {
  get_ux_site_profile: "PLAN_UX_SITE_PROFILE_GET",
  update_ux_site_profile: "PLAN_UX_SITE_PROFILE_UPDATE",
  get_ux_store_view: "PLAN_UX_STORE_VIEW",
  get_ux_opportunity: "PLAN_UX_OPPORTUNITY_GET",
  start_ux_diagnosis: "PLAN_UX_DIAGNOSIS_START",
  update_ux_hypothesis_status: "PLAN_UX_HYPOTHESIS_STATUS_UPDATE",
} as const satisfies Record<string, StudioToolName>;

export type EngineTool = keyof typeof NATIVE_ENGINE_TOOL;

/** Both engines take the same arguments; the native tool's contract types them. */
export type EngineArgs<E extends EngineTool> = StudioToolInput<
  (typeof NATIVE_ENGINE_TOOL)[E]
>;

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : String(error);
}

/** A failed refetch keeps the last good answer, as React Query keeps `data`.
 *  `native` is the org's `plan_engine_native`; the external engine needs
 *  its connection id. */
export function diagnosisStatusState(
  query: { data: StatusOutput | undefined; error: unknown; isPending: boolean },
  retry: () => void,
  native = false,
): DiagnosisStatusState {
  const { data, error } = query;
  if (data) {
    if (data.configured && native) {
      return { state: "configured", target: { kind: "native" } };
    }
    if (data.configured && data.connection_id) {
      return {
        state: "configured",
        target: { kind: "connection", connectionId: data.connection_id },
      };
    }
    return { state: "unconfigured", reason: data.reason ?? "not_connected" };
  }
  if (error) return { state: "error", error: errorMessage(error), retry };
  return { state: "loading" };
}

/** Where engine calls go, or null while they must stay off. */
export function engineTargetOf(
  status: DiagnosisStatusState,
): EngineTarget | null {
  return status.state === "configured" ? status.target : null;
}

/** The part of an engine read's cache key that keeps one engine's answers apart from the other's. */
export function engineScope(target: EngineTarget | null): string {
  if (!target) return "";
  return target.kind === "native"
    ? "native"
    : `connection:${target.connectionId}`;
}

/** Read before the goals load, the view would be every run's instead of
 *  the active goal's. */
export function storeViewEnabled(
  target: EngineTarget | null,
  goal: { pending: boolean },
): boolean {
  return target !== null && !goal.pending;
}

/** The engine answered with an error, or with a shape the page cannot read. */
export class DiagnosisEngineError extends Error {
  constructor(
    message: string,
    /** `start_ux_diagnosis` needs the store's domain first. */
    readonly needsDomain = false,
    readonly needs: SetupNeed[] = [],
    readonly rejected: CompetitorRejection[] = [],
  ) {
    super(message);
    this.name = "DiagnosisEngineError";
  }
}

export function unwrapEngineResult<T>(result: ParsedToolResult<T>): T {
  if (result.ok) return result.value;
  throw new DiagnosisEngineError(
    result.error,
    result.needs_domain === true,
    result.needs,
    result.rejected,
  );
}

/** An engine answer is deterministic, so only a transport failure is retried. */
export function retryEngineRead(failureCount: number, error: unknown): boolean {
  return !(error instanceof DiagnosisEngineError) && failureCount < 1;
}

/** The engine pushes no Studio events, so a running analysis is followed
 *  by polling. It reads the last good view, so a failed poll
 *  does not stop it. */
const RUNNING_POLL_MS = 5000;

export function storeViewRefetchInterval(
  view: StoreView | undefined,
): number | false {
  return view?.running ? RUNNING_POLL_MS : false;
}
