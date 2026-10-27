/**
 * Order-flow rules, pure. Each one compares the last 60 minutes of a store's
 * 15-minute buckets with a baseline: the median of D-1 and W-1..W-4.
 *
 * `orders_drop`'s thresholds are the vtex-monitoring worker's old alerts.ts,
 * calibrated on 28 days of one tenant with a mean baseline and a whole-day
 * level: 0 false alerts, ~1 warning a week, a full outage warns in ~45 min and
 * alerts in ~60 min. The median and the weighted level only resist outliers
 * better; the backtest re-checks them. The spike thresholds are not calibrated yet.
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
// The day before each judged day: a window in the first hour reaches back into it.
export const DAYS_AGO = [0, 1, 2, 7, 8, 14, 15, 21, 22, 28, 29, 364] as const;
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
  /** Buckets of day 0 a DST switch skipped or repeated; a window over them isn't judged. */
  dstBuckets?: number[];
  /** Local day of the store's first `order_events` row, in days before day 0; null when there is none. */
  firstEventDaysAgo: number | null;
  /** Chart only: cancellations by `orders.updated_at`, for reference days before the first event. */
  approximate?: Partial<Record<DayAgo, Pick<DaySeries, "canceled" | "denied">>>;
  /** Chart only: orders placed per sales channel on day 0 and D-1. */
  channels?: {
    id: string;
    name: string | null;
    today: number[];
    d1: number[];
  }[];
}

/** `from`/`to` are bucket indexes of day 0, `to` exclusive; `from` is negative while the window reaches into the day before. */
export type Verdict = Omit<
  OrderMonitorVerdict,
  "timezone" | "ingestIncident" | "crossCheckPending" | "crossCheckSince"
>;

const sum = (a: number[], from = 0, to = a.length) =>
  a.slice(Math.max(0, from), to).reduce((s, v) => s + v, 0);

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/** The baseline over [from, to): the median of the reference days, so one promo or holiday among them doesn't move it. */
const baseSum = (refs: number[][], from: number, to: number) =>
  median(refs.map((r) => sum(r, from, to)));

type Kind = keyof DaySeries;

/** Day `d`'s buckets with the previous day's last hour in front: index i is bucket i - WINDOW. */
const withEve = (
  day: StoreDay,
  d: 0 | (typeof BASELINE_DAYS)[number],
  kind: Kind,
) => [
  ...day.days[(d + 1) as DayAgo][kind].slice(-WINDOW),
  ...day.days[d][kind],
];

function series(day: StoreDay, kind: Kind) {
  return {
    today: withEve(day, 0, kind),
    refs: BASELINE_DAYS.map((d) => withEve(day, d, kind)),
  };
}

/**
 * How today is running vs the baseline before `from`: the median of the
 * hourly ratios, weighted by the baseline's volume, so a launch or live-sale
 * hour doesn't inflate what the hours after it are expected to bring.
 */
function level(today: number[], refs: number[][], from: number): number {
  const hours: { base: number; today: number }[] = [];
  for (let to = from; to > 0; to -= WINDOW) {
    const a = Math.max(0, to - WINDOW);
    hours.push({ base: baseSum(refs, a, to), today: sum(today, a, to) });
  }
  const total = hours.reduce((s, h) => s + h.base, 0);
  if (total < MIN_LEVEL_BASE) return 1;
  const ranked = hours
    .filter((h) => h.base > 0)
    .sort((x, y) => x.today / x.base - y.today / y.base);
  let acc = 0;
  for (const h of ranked) {
    acc += h.base;
    if (acc >= total / 2) return Math.min(2, Math.max(0.5, h.today / h.base));
  }
  return 1;
}

/**
 * Orders over [from - WINDOW, to) vs the baseline's: cancellations and denials
 * trail the orders they belong to by up to an hour, so a campaign hour raises
 * what the next one may cancel. `fallback` when the baseline is too thin.
 */
function recentLevel(
  today: number[],
  refs: number[][],
  from: number,
  to: number,
  fallback: number,
): number {
  const base = baseSum(refs, from - WINDOW, to);
  return base >= MIN_LEVEL_BASE
    ? sum(today, from - WINDOW, to) / base
    : fallback;
}

function spike(
  observed: number,
  expected: number,
  window: { from: number; to: number; level: number },
  judged: boolean,
): Verdict {
  const warnAt = Math.max(MIN_SPIKE, SPIKE_WARN_TIMES * expected);
  const alertAt = Math.max(MIN_SPIKE, SPIKE_ALERT_TIMES * expected);
  const status: Status = !judged
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

/** Every rule's verdict for one store, over the hour that ended at `day.done`. */
export function evaluateStore(day: StoreDay): Record<Rule, Verdict> {
  const placed = series(day, "placed");
  // Indexes into the series with the eve in front.
  const to = day.done + WINDOW;
  const from = to - WINDOW;
  const lv = level(placed.today, placed.refs, from);
  const window = { from: from - WINDOW, to: to - WINDOW, level: lv };
  const dst = (day.dstBuckets ?? []).some(
    (b) => b >= window.from && b < window.to,
  );

  const expected = lv * baseSum(placed.refs, from, to);
  const observed = sum(placed.today, from, to);
  const warnAt = WARN_BELOW * expected;
  const alertAt = ALERT_BELOW * expected;
  const drop: Verdict = {
    status:
      dst || expected < MIN_EXPECTED
        ? "low-volume"
        : observed < alertAt
          ? "alert"
          : observed < warnAt
            ? "warning"
            : "ok",
    ...window,
    observed,
    expected,
    warnAt,
    alertAt,
  };

  const recent = recentLevel(placed.today, placed.refs, from, to, lv);
  const judged = !dst && hasEventHistory(day);
  const rate = (kind: "canceled" | "denied") => {
    const s = series(day, kind);
    return spike(
      sum(s.today, from, to),
      recent * baseSum(s.refs, from, to),
      window,
      judged,
    );
  };
  return {
    orders_drop: drop,
    denied_spike: rate("denied"),
    cancel_spike: rate("canceled"),
  };
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourly = (a: number[], h: number) => sum(a, h * 4, h * 4 + 4);

/**
 * The Monitor chart's view of one store day, per clock hour. Expected is the
 * baseline scaled by the verdict's level; past `done` it is the day's
 * projection. Thresholds mirror the rules', per hour instead of per window.
 */
export function buildDayView(day: StoreDay, at: Date): OrderMonitorDay {
  const today = day.days[0];
  const placed = series(day, "placed");
  const canceled = series(day, "canceled");
  const verdicts = evaluateStore(day);
  // The level the verdict used: the hours before its window, so an outage
  // hour doesn't pull the expected line down with it.
  const lv = verdicts.orders_drop.level;
  const hasHistory = hasEventHistory(day);
  // Hour h in the series with the eve in front.
  const span = (h: number) => [h * 4 + WINDOW, h * 4 + 4 + WINDOW] as const;
  const baseHour = (refs: number[][], h: number) => baseSum(refs, ...span(h));

  const soFar = (a: number[], h: number) =>
    h * 4 < day.done ? sum(a, h * 4, Math.min(h * 4 + 4, day.done)) : null;
  // A reference day before the install has no events; the chart falls back to
  // the approximation, the rules never do.
  const preInstall = (d: DayAgo) =>
    day.firstEventDaysAgo === null || d > day.firstEventDaysAgo;
  const cancels = (d: DayAgo, kind: "canceled" | "denied") =>
    (preInstall(d) ? day.approximate?.[d]?.[kind] : undefined) ??
    day.days[d][kind];
  const hourSeries = (pick: (d: DayAgo) => number[]): OrderMonitorSeries => ({
    today: HOURS.map((h) => soFar(pick(0), h)),
    d1: HOURS.map((h) => hourly(pick(1), h)),
    w1: HOURS.map((h) => hourly(pick(7), h)),
    y1: HOURS.map((h) => hourly(pick(364), h)),
  });

  const expected = HOURS.map((h) => lv * baseHour(placed.refs, h));
  const judged = (e: number, share: number) =>
    e < MIN_EXPECTED ? null : share * e;
  // Elapsed hours scale by the orders around them, as the rule does.
  const cancelLevel = HOURS.map((h) =>
    h * 4 + 4 <= day.done
      ? recentLevel(placed.today, placed.refs, ...span(h), lv)
      : lv,
  );
  const cancelBand = (times: number) =>
    HOURS.map((h) =>
      hasHistory
        ? Math.max(
            MIN_SPIKE,
            times * cancelLevel[h]! * baseHour(canceled.refs, h),
          )
        : null,
    );
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
      ...hourSeries((d) => day.days[d].placed),
      expected,
      warnAt: expected.map((e) => judged(e, WARN_BELOW)),
      alertAt: expected.map((e) => judged(e, ALERT_BELOW)),
    },
    cancellations: {
      canceled: hourSeries((d) => cancels(d, "canceled")),
      denied: hourSeries((d) => cancels(d, "denied")),
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
        lv * baseSum(placed.refs, day.done + WINDOW, BUCKETS_PER_DAY + WINDOW),
      d1: sum(day.days[1].placed),
      w1: sum(day.days[7].placed),
      y1: sum(day.days[364].placed),
    },
    verdicts: {
      orders_drop: withZone(verdicts.orders_drop),
      denied_spike: withZone(verdicts.denied_spike),
      cancel_spike: withZone(verdicts.cancel_spike),
    },
    channels: [...(day.channels ?? [])]
      .sort((a, b) => sum(b.d1) - sum(a.d1) || a.id.localeCompare(b.id))
      .map((c) => ({
        id: c.id,
        name: c.name,
        today: HOURS.map((h) => soFar(c.today, h)),
        d1: HOURS.map((h) => hourly(c.d1, h)),
        soFar: sum(c.today, 0, day.done),
        d1SoFar: sum(c.d1, 0, day.done),
      })),
  };
}
