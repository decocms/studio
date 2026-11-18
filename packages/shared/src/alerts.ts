/** Org-scoped SSE event: an alert opened or was acked. `subject` is the alert id. */
export const ALERTS_UPDATED_EVENT = "alerts.updated";

/** The order monitor's alerts: `subject_id` is the store's ingest connection, `rule` an order-monitor rule. */
export const ORDER_MONITOR_ALERT_SOURCE = "order_monitor";
