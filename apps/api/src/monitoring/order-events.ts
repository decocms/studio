import { ORDER_MONITOR_EVALUATED_EVENT } from "@decocms/shared/order-monitor";
import { sseHub } from "@/event-bus/sse-hub";

/** Tell the org's Monitor views that a store's verdicts or incident changed. */
export function emitOrderMonitorEvaluated(
  organizationId: string,
  connectionId: string,
): void {
  sseHub.emit(organizationId, {
    id: crypto.randomUUID(),
    type: ORDER_MONITOR_EVALUATED_EVENT,
    source: "order-monitor",
    subject: connectionId,
    time: new Date().toISOString(),
  });
}
