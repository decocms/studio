/**
 * What the Monitor page reads, at org or project scope: the business pulse
 * (KPIs), the stores the order monitor watches (the day chart with each push
 * marked on it), what was deployed and what it did, the signals that need a
 * person, the projects side by side, experiments, and the sources feeding
 * the data lake. Sample and live builds fill the same shape, so a section
 * changes source, never component.
 */

import type {
  OrderMonitorChannel,
  OrderMonitorRule,
  OrderMonitorStatus,
  OrderMonitorStore,
} from "@decocms/shared/order-monitor";

export type MonitorStatus = OrderMonitorStatus;

/** Where a number comes from, and what must be connected for it to exist. */
export type SourceId = "orders" | "site" | "deploys" | "analytics" | "search";

export type KpiId =
  | "orders"
  | "conversion"
  | "audience"
  | "latency"
  | "errors"
  | "cancellations";

/** What today is compared with: yesterday, a week ago, a year ago. */
export type Comparison = "d1" | "w1" | "y1";
export const COMPARISONS: readonly Comparison[] = ["d1", "w1", "y1"];

/** One 5-minute bucket of the local day, and the same bucket on each reference day. */
export interface MetricPoint {
  /** Bucket index, 0 = 00:00 to 00:05. */
  bucket: number;
  value: number | null;
  d1: number | null;
  w1: number | null;
  y1: number | null;
}

export const BUCKET_MINUTES = 5;
export const BUCKETS_PER_DAY = (24 * 60) / BUCKET_MINUTES;

export interface Kpi {
  id: KpiId;
  source: SourceId;
  /** Null when its source isn't connected. Orders: projected for the day. */
  value: number | null;
  /** The same figure on each reference day. */
  references: Record<Comparison, number | null>;
  /** Orders so far, next to the projection. */
  soFar?: number;
  /** The day in 5-minute buckets, up to now; null while it loads. */
  points: MetricPoint[] | null;
  /**
   * The rest of the day, after `points`: `value` is what is projected for
   * each bucket, the references are those days' same buckets.
   */
  projection?: MetricPoint[];
  /** A target the metric should stay under, drawn as a threshold. */
  threshold?: number;
}

export interface MonitoredStore {
  store: OrderMonitorStore;
}

export type ImpactMetric = "orders" | "errors" | "latency";
export interface Impact {
  metric: ImpactMetric;
  /** Relative change, the hour after vs the hour before. */
  change: number;
}

export type DeployVerdict =
  | "regression"
  | "improvement"
  | "neutral"
  | "settling";

/** A deploy ships a version; a rollout moves traffic between versions. */
export type ChangeKind = "deploy" | "rollout";

export interface Deploy {
  id: string;
  kind: ChangeKind;
  projectId: string;
  projectTitle: string;
  at: string;
  message: string;
  author: string;
  impact: Impact[];
  verdict: DeployVerdict;
  task: { keySeq: number } | null;
  /** Orders per 5 minutes from an hour before to an hour after. */
  around: number[] | null;
}

export type Signal =
  | {
      kind: "orders";
      id: string;
      severity: "alert" | "warning";
      since: string;
      projectId: string | null;
      storeId: string;
      storeTitle: string;
      rule: OrderMonitorRule;
      observed: number;
      expected: number;
      /** The deploy it started after, when one landed shortly before. */
      after: { message: string; minutes: number } | null;
      task: { keySeq: number } | null;
    }
  | {
      kind: "deploy";
      id: string;
      severity: "alert" | "warning";
      since: string;
      projectId: string;
      projectTitle: string;
      deployId: string;
      message: string;
      metric: ImpactMetric;
      change: number;
      task: { keySeq: number } | null;
    }
  | {
      kind: "experiment";
      id: string;
      severity: "ready";
      since: string;
      projectId: string;
      title: string;
      probability: number;
      participants: number;
    }
  | {
      kind: "source";
      id: string;
      severity: "warning";
      since: string;
      projectId: string | null;
      title: string;
      minutes: number;
    };

export type SignalSeverity = Signal["severity"];

export interface ProjectRow {
  id: string;
  title: string;
  status: MonitorStatus;
  orders: number | null;
  ordersPrevious: number | null;
  ordersSeries: (number | null)[] | null;
  conversion: number | null;
  errorRate: number | null;
  lastDeploy: { at: string; message: string } | null;
  signals: number;
}

export type ExperimentState = "ready" | "running" | "low-traffic";

export interface ExperimentRow {
  id: string;
  projectId: string;
  title: string;
  state: ExperimentState;
  participants: number;
  sampleSize: number;
  /** 0..1, chance the variant beats control. */
  probability: number;
  /** Relative conversion lift of the variant. */
  lift: number;
}

export type SourceState = "live" | "partial" | "off";

export interface SourceRow {
  id: SourceId;
  state: SourceState;
  /** Who provides it and how many of them, e.g. VTEX, 3 stores. */
  detail: { provider: string; count: number } | null;
  lastEventAt: string | null;
  /** Rows kept in the lake, when it lands there. */
  lakeRows: number | null;
  /** The connected connection's own icon; null falls back to the registry's. */
  icon?: string | null;
}

export interface MonitorBoard {
  checkedAt: string | null;
  /** Local midnight of the day on screen; changes are placed against it. */
  dayStart: string;
  kpis: Kpi[];
  /** Orders by sales channel, per hour, across the stores in scope. */
  channels: OrderMonitorChannel[] | null;
  stores: MonitoredStore[];
  deploys: Deploy[] | null;
  /** Every deploy and rollout of the last two weeks, oldest first. */
  deployHistory: Deploy[] | null;
  signals: Signal[];
  projects: ProjectRow[];
  experiments: ExperimentRow[] | null;
  sources: SourceRow[];
}

const SEVERITY_RANK: Record<SignalSeverity, number> = {
  alert: 3,
  warning: 2,
  ready: 1,
};

/** Worst first, then newest. */
export function sortSignals(signals: readonly Signal[]): Signal[] {
  return [...signals].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      b.since.localeCompare(a.since),
  );
}

const STATUS_RANK: Record<MonitorStatus, number> = {
  alert: 3,
  warning: 2,
  ok: 1,
  "low-volume": 0,
};

export function worstStatus(statuses: readonly MonitorStatus[]): MonitorStatus {
  return statuses.reduce<MonitorStatus>(
    (worst, status) =>
      STATUS_RANK[status] > STATUS_RANK[worst] ? status : worst,
    "low-volume",
  );
}

export function storeStatus(store: OrderMonitorStore): MonitorStatus {
  return store.rules.length === 0
    ? "low-volume"
    : worstStatus(store.rules.map((r) => r.status));
}

/** A board narrowed to one project; the org board as is. */
export function scopeBoard(
  board: MonitorBoard,
  scopeId: string | null,
): MonitorBoard {
  if (!scopeId) return board;
  return {
    ...board,
    stores: board.stores.filter((s) => s.store.agentIds.includes(scopeId)),
    deploys: board.deploys?.filter((d) => d.projectId === scopeId) ?? null,
    signals: board.signals.filter(
      (s) => s.projectId === null || s.projectId === scopeId,
    ),
    projects: board.projects.filter((p) => p.id === scopeId),
    experiments:
      board.experiments?.filter((e) => e.projectId === scopeId) ?? null,
  };
}

/** The store's timezone, from its rules' last verdict; the browser's until it has one. */
export const storeTimezone = (store: OrderMonitorStore) =>
  store.rules[0]?.verdict.timezone ??
  Intl.DateTimeFormat().resolvedOptions().timeZone;

export const sum = (values: readonly (number | null)[]) =>
  values.reduce<number>((total, value) => total + (value ?? 0), 0);
