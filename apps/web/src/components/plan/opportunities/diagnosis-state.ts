/**
 * The pure decisions behind `use-plan-diagnosis.ts`: what the status read
 * means for the page, when engine reads run, retry and poll, and how an
 * engine refusal surfaces as an error.
 */

import type { StudioToolOutput } from "@decocms/shared/tools/tool-io";
import type {
  CompetitorRejection,
  ParsedToolResult,
  SetupNeed,
  StoreView,
} from "./diagnosis-schema.ts";

type StatusOutput = StudioToolOutput<"PLAN_DIAGNOSIS_STATUS">;
type UnconfiguredReason = NonNullable<StatusOutput["reason"]>;

export type DiagnosisStatusState =
  | { state: "loading" }
  | { state: "error"; error: string; retry: () => void }
  | { state: "unconfigured"; reason: UnconfiguredReason }
  | { state: "configured"; connectionId: string };

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : String(error);
}

/** A failed refetch keeps the last good answer, as React Query keeps `data`. */
export function diagnosisStatusState(
  query: { data: StatusOutput | undefined; error: unknown; isPending: boolean },
  retry: () => void,
): DiagnosisStatusState {
  const { data, error } = query;
  if (data) {
    if (data.configured && data.connection_id) {
      return { state: "configured", connectionId: data.connection_id };
    }
    return { state: "unconfigured", reason: data.reason ?? "not_connected" };
  }
  if (error) return { state: "error", error: errorMessage(error), retry };
  return { state: "loading" };
}

/** The engine connection to read from, or null while reads must stay off. */
export function engineConnectionOf(
  status: DiagnosisStatusState,
): string | null {
  return status.state === "configured" ? status.connectionId : null;
}

/** Read before the goals load, the view would be every run's instead of
 *  the active goal's. */
export function storeViewEnabled(
  connectionId: string | null,
  goal: { pending: boolean },
): boolean {
  return connectionId !== null && !goal.pending;
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

/** An external connection cannot push Studio events, so a running analysis
 *  is followed by polling. It reads the last good view, so a failed poll
 *  does not stop it. */
const RUNNING_POLL_MS = 5000;

export function storeViewRefetchInterval(
  view: StoreView | undefined,
): number | false {
  return view?.running ? RUNNING_POLL_MS : false;
}
