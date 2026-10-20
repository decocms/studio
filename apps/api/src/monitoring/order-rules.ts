/**
 * Order-flow rules, pure. Each one compares the last 60 minutes of a store's
 * 15-minute buckets with a baseline: the mean of D-1 and W-1..W-4.
 *
 * `orders_drop` is the vtex-monitoring worker's old alerts.ts, unchanged,
 * calibrated on 28 days of one tenant: 0 false alerts, ~1 warning a week, a
 * full outage warns in ~45 min and alerts in ~60 min. The spike thresholds are
 * not calibrated yet.
 */

import type {
  OrderMonitorDay,
  OrderMonitorRule as Rule,
  OrderMonitorSeries,
  OrderMonitorStatus as Status,
  OrderMonitorVerdict,
} from "@decocms/shared/order-monitor";

export { ORDER_MONITOR_RULES as RULES } from "@decocms/shared/order-monitor";
export type { Rule, Status };

/**
 * Which rules open a task on the org's board. Off = shadow: the verdict is
 * written and the transition logged, nothing else. Each one goes on after its
 * thresholds are backtested on every monitored store (scripts/order-monitor-backtest.ts)
 * and its shadow transitions are checked against what actually happened.
 */
export const NOTIFY: Record<Rule, boolean> = {
  orders_drop: false,
  denied_spike: false,
  cancel_spike: false,
};

const WINDOW = 4; // 15-minute buckets = last 60 minutes
export const BUCKETS_PER_DAY = 96;
const WARN_BELOW = 0.3; // warning when the hour brings < 30% of expected
const ALERT_BELOW = 0.15; // alert when < 15% of expected
const MIN_EXPECTED = 20; // at night an hour with few orders is normal; don't judge
const MIN_LEVEL_BASE = 30; // orders the reference days need before today's level is trusted

// ponytail: uncalibrated. The shadow backtest on every monitored store sets these.
const SPIKE_WARN_TIMES = 3;
const SPIKE_ALERT_TIMES = 5;
const MIN_SPIKE = 10; // fewer cancellations or denials than this in an hour is never a spike

/** Days back from the evaluated day. D-1 and W-1..W-4 are the baseline; Y-1 is shown, never judged. */
const BASELINE_DAYS = [1, 7, 14, 21, 28] as const;
export const DAYS_AGO = [0, ...BASELINE_DAYS, 364] as const;
export type DayAgo = (typeof DAYS_AGO)[number];

/** Per 15-minute bucket of one local day. */
export interface DaySeries {
  placed: number[];
  canceled: number[];
  denied: number[];
}

export interface StoreDay {
  timezone: string;
  /** Fully elapsed buckets of day 0 (ingest grace included). */
  done: number;
  days: Record<DayAgo, DaySeries>;
  /** Local day of the store's first `order_events` row, in days before day 0; null when there is none. */
  firstEventDaysAgo: number | null;
  /** Chart only: cancellations by `orders.updated_at`, for reference days before the first event. */
  approximate?: Partial<Record<DayAgo, Pick<DaySeries, "canceled" | "denied">>>;
}

/** `from`/`to` are bucket indexes, `to` exclusive. */
export type Verdict = Omit<OrderMonitorVerdict, "timezone" | "ingestIncident">;

const sum = (a: number[], from = 0, to = a.length) =>
  a.slice(Math.max(0, from), to).reduce((s, v) => s + v, 0);

function baseline(refs: number[][]): number[] {
  return refs[0]!.map(
    (_, i) => refs.reduce((s, r) => s + r[i]!, 0) / refs.length,
  );
}

/** How today is running vs the baseline before `from`, so a strong or weak day isn't read as an incident. */
function level(today: number[], base: number[], from: number): number {
  const b = sum(base, 0, from);
  return b >= MIN_LEVEL_BASE
    ? Math.min(2, Math.max(0.5, sum(today, 0, from) / b))
    : 1;
}

/** today/base: orders per bucket. done: fully elapsed buckets. Null before the first full window. */
function evaluate(
  today: number[],
  base: number[],
  done: number,
): Verdict | null {
  if (done < WINDOW) return null;
  const from = done - WINDOW;
  const to = done;
  const lv = level(today, base, from);
  const expected = lv * sum(base, from, to);
  const observed = sum(today, from, to);
  const warnAt = WARN_BELOW * expected;
  const alertAt = ALERT_BELOW * expected;
  const status: Status =
    expected < MIN_EXPECTED
      ? "low-volume"
      : observed < alertAt
        ? "alert"
        : observed < warnAt
          ? "warning"
          : "ok";
  return { status, from, to, observed, expected, warnAt, alertAt, level: lv };
}

function spike(
  observed: number,
  expected: number,
  window: { from: number; to: number; level: number },
  hasHistory: boolean,
): Verdict {
  const warnAt = Math.max(MIN_SPIKE, SPIKE_WARN_TIMES * expected);
  const alertAt = Math.max(MIN_SPIKE, SPIKE_ALERT_TIMES * expected);
  const status: Status = !hasHistory
    ? "low-volume"
    : observed >= alertAt
      ? "alert"
      : observed >= warnAt
        ? "warning"
        : "ok";
  return { status, ...window, observed, expected, warnAt, alertAt };
}

// Cancellations count by when they happened, and `order_events` starts at the
// install: until the oldest baseline day is fully covered, a spike can't be judged.
function hasEventHistory(day: StoreDay): boolean {
  return (
    day.firstEventDaysAgo !== null &&
    day.firstEventDaysAgo > BASELINE_DAYS[BASELINE_DAYS.length - 1]!
  );
}

/** Every rule's verdict for one store, or null for all of them before the day's first full window. */
export function evaluateStore(day: StoreDay): Record<Rule, Verdict> | null {
  const today = day.days[0];
  const refs = BASELINE_DAYS.map((d) => day.days[d]);
  const basePlaced = baseline(refs.map((r) => r.placed));
  const drop = evaluate(today.placed, basePlaced, day.done);
  if (!drop) return null;
  const { from, to, level: lv } = drop;
  const window = { from, to, level: lv };

  const hasHistory = hasEventHistory(day);
  const baseCanceled = baseline(refs.map((r) => r.canceled));
  const canceled = spike(
    sum(today.canceled, from, to),
    lv * sum(baseCanceled, from, to),
    window,
    hasHistory,
  );

  const refPlaced = sum(refs.flatMap((r) => r.placed));
  const deniedShare =
    refPlaced > 0 ? sum(refs.flatMap((r) => r.denied)) / refPlaced : 0;
  const denied = spike(
    sum(today.denied, from, to),
    sum(today.placed, from, to) * deniedShare,
    window,
    hasHistory,
  );

  return { orders_drop: drop, denied_spike: denied, cancel_spike: canceled };
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourly = (a: number[], h: number) => sum(a, h * 4, h * 4 + 4);

/**
 * The Monitor chart's view of one store day, per clock hour. Expected is the
 * baseline scaled by how today ran before `done`; past `done` it is the day's
 * projection. Thresholds mirror the rules', per hour instead of per window.
 */
export function buildDayView(day: StoreDay, at: Date): OrderMonitorDay {
  const today = day.days[0];
  const refs = BASELINE_DAYS.map((d) => day.days[d]);
  const basePlaced = baseline(refs.map((r) => r.placed));
  const baseCanceled = baseline(refs.map((r) => r.canceled));
  // The level the verdict used: the buckets before its window, so an outage
  // hour doesn't pull the expected line down with it.
  const lv = level(
    today.placed,
    basePlaced,
    day.done >= WINDOW ? day.done - WINDOW : day.done,
  );
  const hasHistory = hasEventHistory(day);

  const soFar = (a: number[], h: number) =>
    h * 4 < day.done ? sum(a, h * 4, Math.min(h * 4 + 4, day.done)) : null;
  // A reference day before the install has no events; the chart falls back to
  // the approximation, the rules never do.
  const preInstall = (d: DayAgo) =>
    day.firstEventDaysAgo === null || d > day.firstEventDaysAgo;
  const cancels = (d: DayAgo, kind: "canceled" | "denied") =>
    (preInstall(d) ? day.approximate?.[d]?.[kind] : undefined) ??
    day.days[d][kind];
  const series = (pick: (d: DayAgo) => number[]): OrderMonitorSeries => ({
    today: HOURS.map((h) => soFar(pick(0), h)),
    d1: HOURS.map((h) => hourly(pick(1), h)),
    w1: HOURS.map((h) => hourly(pick(7), h)),
    y1: HOURS.map((h) => hourly(pick(364), h)),
  });

  const expected = HOURS.map((h) => lv * hourly(basePlaced, h));
  const judged = (e: number, share: number) =>
    e < MIN_EXPECTED ? null : share * e;
  const cancelBand = (times: number) =>
    HOURS.map((h) =>
      hasHistory
        ? Math.max(MIN_SPIKE, times * lv * hourly(baseCanceled, h))
        : null,
    );
  const verdicts = evaluateStore(day);
  const withZone = (v: Verdict): OrderMonitorVerdict => ({
    ...v,
    timezone: day.timezone,
  });

  return {
    at: at.toISOString(),
    timezone: day.timezone,
    // en-CA formats as YYYY-MM-DD.
    date: at.toLocaleDateString("en-CA", { timeZone: day.timezone }),
    done: day.done,
    orders: {
      ...series((d) => day.days[d].placed),
      expected,
      warnAt: expected.map((e) => judged(e, WARN_BELOW)),
      alertAt: expected.map((e) => judged(e, ALERT_BELOW)),
    },
    cancellations: {
      canceled: series((d) => cancels(d, "canceled")),
      denied: series((d) => cancels(d, "denied")),
      approximate: {
        d1: preInstall(1) && !!day.approximate?.[1],
        w1: preInstall(7) && !!day.approximate?.[7],
        y1: preInstall(364) && !!day.approximate?.[364],
      },
      canceledWarnAt: cancelBand(SPIKE_WARN_TIMES),
      canceledAlertAt: cancelBand(SPIKE_ALERT_TIMES),
    },
    headline: {
      projected:
        sum(today.placed, 0, day.done) +
        lv * sum(basePlaced, day.done, BUCKETS_PER_DAY),
      d1: sum(day.days[1].placed),
      w1: sum(day.days[7].placed),
      y1: sum(day.days[364].placed),
    },
    verdicts: verdicts && {
      orders_drop: withZone(verdicts.orders_drop),
      denied_spike: withZone(verdicts.denied_spike),
      cancel_spike: withZone(verdicts.cancel_spike),
    },
  };
}
