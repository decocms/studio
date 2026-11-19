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

/** `warnAt`/`alertAt` are below expected for a drop, above it for a spike. Buckets are 15 minutes of the store's local day; `from` is negative while the window reaches into the day before. */
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
}

/**
 * What makes a rule alert, per org. `orders_drop`: the hour brought less than
 * `threshold` % of expected, judged once `minVolume` orders were expected.
 * The spikes: `threshold` times expected, and at least `minVolume` in the hour.
 */
export interface OrderMonitorThreshold {
  threshold: number;
  minVolume: number;
}
export type OrderMonitorThresholds = Record<
  OrderMonitorRule,
  OrderMonitorThreshold
>;

export const ORDER_MONITOR_DEFAULT_THRESHOLDS: OrderMonitorThresholds = {
  orders_drop: { threshold: 15, minVolume: 20 },
  denied_spike: { threshold: 5, minVolume: 10 },
  cancel_spike: { threshold: 5, minVolume: 10 },
};

export interface OrderMonitorRuleState {
  rule: OrderMonitorRule;
  status: OrderMonitorStatus;
  since: string;
  evaluatedAt: string;
  verdict: OrderMonitorVerdict;
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

/** One sales channel's orders (`orders.sales_channel`), per clock hour like `OrderMonitorDay.orders`. */
export interface OrderMonitorChannel {
  id: string;
  /** The store's name for the channel; null until the ingest has written one. */
  name: string | null;
  today: (number | null)[];
  d1: number[];
  /** Orders today so far, and on D-1 up to the same time of day. */
  soFar: number;
  d1SoFar: number;
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
  /** The day's sales status: what's in so far beside the same time of day on W-1, M-1 (4 weeks back) and Y-1, and where the day is heading. */
  forecast: {
    /** The orders' currency (ISO 4217); null when the day has no orders yet. */
    currency: string | null;
    /** Revenue per clock hour, as `orders`. */
    revenue: OrderMonitorSeries;
    /** Up to `done`; a reference day is null when the lake has no order of it. */
    soFar: {
      today: OrderMonitorSales;
      w1: OrderMonitorSales | null;
      m1: OrderMonitorSales | null;
      y1: OrderMonitorSales | null;
    };
    /** The baseline × today's level, as `headline.projected`; null without reference days. */
    projection: OrderMonitorForecast | null;
  };
  verdicts: Record<OrderMonitorRule, OrderMonitorVerdict>;
  /** Hours of history the ingest still has queued; null once it's all in. Days not in yet are left out of the baseline. */
  backfill: { pending: number; total: number } | null;
  /** Busiest on D-1 first, so a channel keeps its place and color through the day. */
  channels: OrderMonitorChannel[];
}

export interface OrderMonitorSales {
  orders: number;
  /** In the store's currency. */
  revenue: number;
  items: number;
}

/** What the rest of a store's day should bring. */
export interface OrderMonitorForecast {
  /** Per clock hour, what is still to come of it after `done`; 0 for hours gone. */
  orders: number[];
  revenue: number[];
  /** Where the day closes: so far plus the rest. */
  close: { orders: number; revenue: number };
  /** The projection before the day's first order: the baseline's whole day. */
  initial: { orders: number; revenue: number };
}

/** The org's sites' traffic (Deco Analytics, read from the data lake), per clock hour of the local day. */
export interface SiteTrafficDay {
  /** Unique visitors in each hour. */
  visitors: OrderMonitorSeries;
  pageviews: OrderMonitorSeries;
  /** Purchases the sites reported to the collector. */
  conversions: OrderMonitorSeries;
  /** Today so far, and each reference day up to the same hour. Visitors are
   *  the day's uniques, not the hours summed. */
  headline: {
    visitors: { today: number; d1: number; w1: number; y1: number };
    pageviews: { today: number; d1: number; w1: number; y1: number };
    conversions: { today: number; d1: number; w1: number; y1: number };
  };
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
