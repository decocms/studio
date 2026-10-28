/**
 * Wire contract of the order monitor: the sweep's verdicts and the Monitor UI's
 * reads (`/api/:org/order-monitor/...`). The rules themselves live in
 * `apps/api/src/monitoring/order-rules.ts`.
 */

/** Org-scoped SSE event: a store's verdicts changed. `subject` is the store's connection id. */
export const ORDER_MONITOR_EVALUATED_EVENT = "order-monitor.store.evaluated";

/** What a new order ingest install is called before it is named after its VTEX account. */
export const ORDER_INGEST_TITLE = "VTEX order monitoring";

/** The VTEX account a connection's configuration names. Reads the account only, never the keys beside it. */
export function vtexAccountOf(state: unknown): string | null {
  if (typeof state !== "object" || state === null) return null;
  const name = (state as { accountName?: unknown }).accountName;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

/** A VTEX connection as a person picks it: its title, and the account when the title doesn't already say it. */
export function vtexConnectionLabel(
  title: string,
  account: string | null,
): string {
  return account && !title.toLowerCase().includes(account.toLowerCase())
    ? `${title} · ${account}`
    : title;
}

/** The order ingest install's title: the monitor, and the account it watches. */
export const orderIngestTitle = (account: string | null) =>
  vtexConnectionLabel(ORDER_INGEST_TITLE, account);

/** A store as the Monitor and its incident cards name it: the VTEX account it watches, else its install's title. */
export const orderStoreLabel = (installTitle: string, account: string | null) =>
  account ?? installTitle;

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
  /** The lake saw a drop VTEX did not: our ingest stopped, not the store's sales. */
  ingestIncident?: boolean;
  /** The card waits on VTEX to confirm the drop; the sweep retries the open. */
  crossCheckPending?: boolean;
  /** When the open started waiting on VTEX; the wait is bounded from here. */
  crossCheckSince?: string;
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
  verdicts: Record<OrderMonitorRule, OrderMonitorVerdict>;
  /** Hours of history the ingest still has queued; null once it's all in. Days not in yet are left out of the baseline. */
  backfill: { pending: number; total: number } | null;
  /** Busiest on D-1 first, so a channel keeps its place and color through the day. */
  channels: OrderMonitorChannel[];
}

/** The org's sites' traffic (Deco Analytics, read from the data lake), per clock hour of the local day. */
export interface SiteTrafficDay {
  /** Unique visitors in each hour. */
  visitors: OrderMonitorSeries;
  /** Purchases the sites reported to the collector. */
  conversions: OrderMonitorSeries;
  /** Today so far, and each reference day up to the same hour. Visitors are
   *  the day's uniques, not the hours summed. */
  headline: {
    visitors: { today: number; d1: number; w1: number; y1: number };
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
