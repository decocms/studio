import { ALERTS_UPDATED_EVENT } from "@decocms/shared/alerts";
import { sseHub } from "@/event-bus/sse-hub";

/** Tell the org's views that an alert opened or was acked. */
export function emitAlertsUpdated(organizationId: string, alertId: string) {
  sseHub.emit(organizationId, {
    id: crypto.randomUUID(),
    type: ALERTS_UPDATED_EVENT,
    source: "alerts",
    subject: alertId,
    time: new Date().toISOString(),
  });
}
