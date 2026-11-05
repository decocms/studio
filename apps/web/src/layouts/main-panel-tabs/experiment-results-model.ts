/**
 * The arithmetic behind the experiment results screens: how two arms compare
 * on one rate, how long until a difference can show, and the Analytics tab's
 * `variants` rows read the same whatever the read surface named the columns.
 */

export interface ArmCounts {
  successes: number;
  total: number;
}

export type Verdict = "few" | "tie" | "ahead" | "behind";

export interface Comparison {
  controlRate: number;
  treatmentRate: number;
  /** Relative difference, treatment / control − 1. Null when control is 0. */
  lift: number | null;
  /** 95% interval of `lift`. */
  low: number | null;
  high: number | null;
  /** Two-sided p of the pooled two-proportion z test. */
  p: number | null;
  verdict: Verdict;
}

/** Below either, a verdict would be noise. */
export const MIN_TOTAL = 100;
export const MIN_SUCCESSES = 10;
/** The relative difference the time estimate is for. */
export const DETECTABLE_LIFT = 0.1;

const Z_95 = 1.959964;
const Z_POWER_80 = 0.841621;

/** Standard-normal CDF (Abramowitz & Stegun 7.1.26, |error| < 1.5e-7), the
 *  same approximation the API's `ab-test.ts` uses. */
function normalCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

const rate = (a: ArmCounts) => (a.total > 0 ? a.successes / a.total : 0);

const isFew = (c: ArmCounts, t: ArmCounts) =>
  Math.min(c.total, t.total) < MIN_TOTAL ||
  Math.min(c.successes, t.successes) < MIN_SUCCESSES;

/** Treatment against control on one rate. The interval is the normal
 *  approximation of the difference of proportions, divided by control's rate. */
export function compareArms(c: ArmCounts, t: ArmCounts): Comparison {
  const controlRate = rate(c);
  const treatmentRate = rate(t);
  const few = isFew(c, t);
  if (controlRate === 0 || c.total === 0 || t.total === 0) {
    return {
      controlRate,
      treatmentRate,
      lift: null,
      low: null,
      high: null,
      p: null,
      verdict: "few",
    };
  }
  const diff = treatmentRate - controlRate;
  const se = Math.sqrt(
    (controlRate * (1 - controlRate)) / c.total +
      (treatmentRate * (1 - treatmentRate)) / t.total,
  );
  const pooled = (c.successes + t.successes) / (c.total + t.total);
  const sePooled = Math.sqrt(
    pooled * (1 - pooled) * (1 / c.total + 1 / t.total),
  );
  const p = sePooled > 0 ? 2 * (1 - normalCdf(Math.abs(diff) / sePooled)) : 1;
  const low = (diff - Z_95 * se) / controlRate;
  const high = (diff + Z_95 * se) / controlRate;
  return {
    controlRate,
    treatmentRate,
    lift: diff / controlRate,
    low,
    high,
    p,
    verdict: few
      ? "few"
      : low > 0 && p < 0.05
        ? "ahead"
        : high < 0
          ? "behind"
          : "tie",
  };
}

/**
 * Days still needed, at the traffic of the `days` so far, to detect a
 * {@link DETECTABLE_LIFT} relative difference on control's rate (95%
 * two-sided, 80% power), each arm at its own pace. 0 once there is enough;
 * null while there is too little data to estimate.
 */
export function daysLeft(
  c: ArmCounts,
  t: ArmCounts,
  days: number,
  lift = DETECTABLE_LIFT,
): number | null {
  if (days <= 0 || isFew(c, t)) return null;
  const p1 = rate(c);
  const p2 = p1 * (1 + lift);
  if (p1 <= 0 || p2 >= 1) return null;
  const perDayC = c.total / days;
  const perDayT = t.total / days;
  const needed =
    ((Z_95 + Z_POWER_80) ** 2 *
      ((p1 * (1 - p1)) / perDayC + (p2 * (1 - p2)) / perDayT)) /
    (p2 - p1) ** 2;
  return Math.max(0, Math.ceil(needed - days));
}

/** Whole days since `startedAt`, at least 1 once it has started. */
export function daysRunning(startedAt: string | null, now: number): number {
  const start = Date.parse(startedAt ?? "");
  if (!Number.isFinite(start) || start > now) return 0;
  return Math.max(1, Math.ceil((now - start) / 86_400_000));
}

export interface VariantRow {
  experiment: string;
  variant: string;
  visitors: number;
  converters: number;
  /** Conversion as 0–100. */
  cr: number;
  revenue: number | null;
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** One `variants` row of the Analytics `experiments` view. The read surface
 *  calls converters `conv` from its rollup and `converters` from raw events,
 *  and rounds `cr`; the rate is recomputed from the counts when it can be. */
export function normalizeVariantRow(row: Record<string, unknown>): VariantRow {
  const visitors = num(row.visitors);
  const raw = row.converters ?? row.conv;
  const converters = num(raw);
  return {
    experiment: String(row.experiment ?? ""),
    variant: String(row.variant ?? ""),
    visitors,
    converters,
    cr:
      raw !== undefined && visitors > 0
        ? (100 * converters) / visitors
        : num(row.cr),
    revenue:
      row.revenue === undefined || row.revenue === null
        ? null
        : num(row.revenue),
  };
}
