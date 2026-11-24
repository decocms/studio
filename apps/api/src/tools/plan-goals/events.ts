import { PLAN_GOALS_UPDATED_EVENT } from "@decocms/shared/plan-goals";
import { sseHub } from "@/event-bus/sse-hub";

/** Tell the org's Plan pages that a goal, or who works toward one, changed. */
export function emitPlanGoalsUpdated(organizationId: string, goalId: string) {
  sseHub.emit(organizationId, {
    id: crypto.randomUUID(),
    type: PLAN_GOALS_UPDATED_EVENT,
    source: "plan-goals",
    subject: goalId,
    time: new Date().toISOString(),
  });
}
