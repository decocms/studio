/**
 * Wire contract of the order monitor: the sweep's verdicts and the Monitor UI's
 * reads (`/api/:org/order-monitor/...`). The rules themselves live in
 * `apps/api/src/monitoring/order-rules.ts`.
 */

/** Org-scoped SSE event: a store's verdicts changed. `subject` is the store's connection id. */
export const ORDER_MONITOR_EVALUATED_EVENT = "order-monitor.store.evaluated";

export const ORDER_MONITOR_RULES = [
  "orders_drop",
  "denied_spike",
  "cancel_spike",
] as const;
export type OrderMonitorRule = (typeof ORDER_MONITOR_RULES)[number];
export type OrderMonitorStatus = "ok" | "warning" | "alert" | "low-volume";

/** `warnAt`/`alertAt` are below expected for a drop, above it for a spike. Buckets are 15 minutes of the store's local day. */
export interface OrderMonitorVerdict {
  status: OrderMonitorStatus;
  from: number;
  to: number;
  observed: number;
  expected: number;
  warnAt: number;
  alertAt: number;
  level: number;
  timezone: string;
  /** The lake saw a drop VTEX did not: our ingest stopped, not the store's sales. */
  ingestIncident?: boolean;
}

export interface OrderMonitorRuleState {
  rule: OrderMonitorRule;
  status: OrderMonitorStatus;
  since: string;
  evaluatedAt: string;
  verdict: OrderMonitorVerdict;
  /** The open incident's card, when there is one. */
  task: { id: string; keySeq: number } | null;
}

export interface OrderMonitorStore {
  connectionId: string;
  title: string;
  /** Agents that aggregate the VTEX connection this store's ingest is bound to. */
  agentIds: string[];
  rules: OrderMonitorRuleState[];
}

/** Per clock hour of the store's local day (24 entries). Null = not happened yet. */
export interface OrderMonitorSeries {
  today: (number | null)[];
  d1: number[];
  w1: number[];
  y1: number[];
}

export interface OrderMonitorDay {
  at: string;
  timezone: string;
  /** The local day, `YYYY-MM-DD`. */
  date: string;
  /** Fully elapsed 15-minute buckets (ingest grace included). */
  done: number;
  orders: OrderMonitorSeries & {
    /** Baseline × today's level, for the whole day; past `done` it is the projection. */
    expected: number[];
    /** Null where the hour is too quiet to judge. */
    warnAt: (number | null)[];
    alertAt: (number | null)[];
  };
  cancellations: {
    canceled: OrderMonitorSeries;
    denied: OrderMonitorSeries;
    /** Reference days before the install's first hook event: counted by `orders.updated_at`, drawn dashed. */
    approximate: { d1: boolean; w1: boolean; y1: boolean };
    /** Null before the rules have 28 days of hook history. */
    canceledWarnAt: (number | null)[];
    canceledAlertAt: (number | null)[];
  };
  headline: {
    /** Today so far + level × the rest of the baseline. */
    projected: number;
    d1: number;
    w1: number;
    y1: number;
  };
  /** Null before the day's first full hour. */
  verdicts: Record<OrderMonitorRule, OrderMonitorVerdict> | null;
}

export interface OrderMonitorPush {
  /** First bucket of the local day (15 minutes) the commits fall in. */
  bucket: number;
  /** Committer date of the earliest commit in the bucket. */
  time: string;
  commits: { sha: string; message: string; author: string }[];
}

export interface OrderMonitorPushes {
  repos: {
    repositoryId: string;
    name: string;
    markers: OrderMonitorPush[];
  }[];
}

/** What an `order_incident` notification carries (`notifications.data.incident`). */
export interface OrderIncidentNotice {
  connectionId: string;
  store: string;
  rule: OrderMonitorRule;
  /** `ok` = recovered. */
  status: OrderMonitorStatus;
  observed: number;
  expected: number;
  since: string;
  /** The store's zone, to render `since` in local time. */
  timezone: string;
  /** The chart instant the notice links to (`?at=`). */
  at: string;
}

/** The org Monitoring page's Stores tab, opened on one store at one instant. */
export function orderMonitorChartPath(
  orgSlug: string,
  connectionId: string,
  at: string,
): string {
  const search = new URLSearchParams({
    tab: "stores",
    store: connectionId,
    at,
  });
  return `/${encodeURIComponent(orgSlug)}/settings/monitor?${search}`;
}
