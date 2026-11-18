/** Org-scoped SSE event: an alert opened or was acked. `subject` is the alert id. */
export const ALERTS_UPDATED_EVENT = "alerts.updated";

/** The order monitor's alerts: `subject_id` is the store's ingest connection, `rule` an order-monitor rule. */
export const ORDER_MONITOR_ALERT_SOURCE = "order_monitor";

/** Site traffic's alerts: `subject_id` is the Deco Analytics site id. */
export const SITE_TRAFFIC_ALERT_SOURCE = "site_traffic";

export const SITE_TRAFFIC_RULES = ["visitors_drop", "pageviews_drop"] as const;
export type SiteTrafficRule = (typeof SITE_TRAFFIC_RULES)[number];

/** A drop rule's thresholds: alert when the hour brings less than `threshold` % of expected, judged once `minVolume` were expected. */
export type SiteTrafficThresholds = Record<
  SiteTrafficRule,
  { threshold: number; minVolume: number }
>;

export const SITE_TRAFFIC_DEFAULT_THRESHOLDS: SiteTrafficThresholds = {
  visitors_drop: { threshold: 30, minVolume: 100 },
  pageviews_drop: { threshold: 30, minVolume: 300 },
};
