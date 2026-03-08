import type { RunEvent, RunState } from "./run-state.ts";

export function project(
  state: RunState | undefined,
  event: RunEvent,
  now: Date = new Date(),
): RunState | undefined {
  switch (event.type) {
    case "RUN_STARTED":
      return {
        threadId: event.threadId,
        orgId: event.orgId,
        userId: event.userId,
        status: {
          tag: "running",
          abortController: event.abortController,
          stepCount: 0,
          startedAt: now,
        },
      };

    case "STEP_COMPLETED":
      if (state?.status.tag !== "running") return state;
      return {
        ...state,
        status: { ...state.status, stepCount: event.stepCount },
      };

    case "RUN_COMPLETED":
      // Return undefined to evict the entry from the registry Map.
      // orgId is now carried on the event so the reactor can still emit SSE.
      return undefined;

    case "RUN_REQUIRES_ACTION":
      // Same as RUN_COMPLETED — evict from Map; orgId carried on event.
      return undefined;

    case "RUN_FAILED":
      return undefined;

    case "PREVIOUS_RUN_ABORTED":
      return undefined;
  }
}
