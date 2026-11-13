/**
 * The arithmetic behind the experiment results screen: how the test arm
 * compares with control on one rate, what that lets us say, and how long until
 * the answer firms up.
 *
 * The method is the rollout plan's (Leandro Borges, decocms/reports#439,
 * `scripts/ab-rollout-stats.ts`), ported formula for formula:
 *
 * - the lift's margin is the normal approximation on the relative lift, with
 *   both arms at control's rate, times a design effect (§3);
 * - "how sure" questions use the log of the ratio of rates, one-sided at 95%,
 *   with a flat prior, so the range is not symmetric (§5);
 * - the test is safe to grow once it is not worse than −2% (non-inferiority,
 *   one-sided 95%), and a drop counts once it is significant one-sided (§6);
 * - a measured lift counts only when significant (one-sided 95%, §7).
 *
 * Adaptation: the plan counts sessions; this screen counts visitor-days among
 * the exposed (or among all visitors before exposure fires), and the split is
 * still by visitor, so the same 1.3 design effect stands in for the clustering
 * of one visitor across days. The plan sums information stage by stage; here
 * the arms' observed totals are used directly, which is the same thing for a
 * test that never changed its split.
 */

export interface ArmCounts {
  successes: number;
  total: number;
}

/** What can be said so far, strongest first. */
export type Verdict = "few" | "better" | "worse" | "notWorse" | "unclear";

/** Non-inferiority at {@link NON_INFERIORITY}: safe to grow, still open, or a significant drop. */
export type Safety = "notWorse" | "open" | "worse";

export interface Comparison {
  controlRate: number;
  treatmentRate: number;
  /** Relative difference, treatment / control − 1. Null when control is 0. */
  lift: number | null;
  /** 95% range of `lift`, two-sided, on the log of the ratio. */
  low: number | null;
  high: number | null;
  /** Half-width of the 95% range on the relative lift (the plan's "±"). */
  margin: number | null;
  /** The measured lift that proves "not worse than −2%" at this volume. */
  notWorseAt: number | null;
  /** Chance the test converts better than control (flat prior). */
  pBetter: number | null;
  /** Chance it converts at least {@link TARGET_LIFT} better. */
  pBetterTarget: number | null;
  safety: Safety | null;
  /** The lift clears zero one-sided at 95%: the measured lift counts. */
  significant: boolean;
  verdict: Verdict;
}

/** Below either, a verdict would be noise. */
export const MIN_TOTAL = 100;
export const MIN_SUCCESSES = 10;
/** Visitor split, visitor-days counted (the plan's 1.3 for sessions). */
export const DEFF = 1.3;
/** The plan's GO rule: not worse than this, one-sided at 95%. */
export const NON_INFERIORITY = -0.02;
/** The "at least this much better" the plan asks about. */
export const TARGET_LIFT = 0.1;

export const Z_95 = 1.959964;
export const Z_95_ONE_SIDED = 1.644854;

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

/** Standard error of the relative lift, both arms at `rate` (plan §3:
 *  `sqrt(deff · (1 − p)/p / info)`, info = 1 / (1/nControl + 1/nTest)). */
export function liftSe(
  rate: number,
  nControl: number,
  nTest: number,
  deff = DEFF,
): number {
  return Math.sqrt(deff * ((1 - rate) / rate) * (1 / nControl + 1 / nTest));
}

/** Standard error of ln(test rate / control rate) (plan §5). */
export function logRatioSe(
  controlRate: number,
  nControl: number,
  testRate: number,
  nTest: number,
  deff = DEFF,
): number {
  return Math.sqrt(
    deff *
      ((1 - testRate) / (nTest * testRate) +
        (1 - controlRate) / (nControl * controlRate)),
  );
}

/** Range of the lift on the log scale: `z` = {@link Z_95} for 95% two-sided,
 *  {@link Z_95_ONE_SIDED} for the plan's p5 to p95. */
export function logInterval(
  lift: number,
  seLog: number,
  z = Z_95,
): [number, number] {
  const m = Math.log(1 + lift);
  return [Math.exp(m - z * seLog) - 1, Math.exp(m + z * seLog) - 1];
}

/** Confidence the real lift is above `target`, one-sided, flat prior (plan §5). */
export function confidenceAbove(
  lift: number,
  target: number,
  seLog: number,
): number {
  const gap = Math.log(1 + lift) - Math.log(1 + target);
  if (seLog === 0) return gap > 0 ? 1 : gap < 0 ? 0 : 0.5;
  return normalCdf(gap / seLog);
}

/** The lift to measure before claiming more than `target` at 95% (plan §5). */
export function liftNeededToClaim(target: number, seLog: number): number {
  return Math.exp(Math.log(1 + target) + Z_95_ONE_SIDED * seLog) - 1;
}

/** The measured lift that proves "not worse than −2%" (plan §6). */
export function nonInferiorityBar(se: number): number {
  return NON_INFERIORITY + Z_95_ONE_SIDED * se;
}

/** How much longer a split with `share` on the test takes than 50/50 for the
 *  same precision: (1/t + 1/(1 − t)) / 4 (plan, slide "desvio"). */
export function splitCost(share: number): number {
  return (1 / share + 1 / (1 - share)) / 4;
}

const rate = (a: ArmCounts) => (a.total > 0 ? a.successes / a.total : 0);

const isFew = (c: ArmCounts, t: ArmCounts) =>
  Math.min(c.total, t.total) < MIN_TOTAL ||
  Math.min(c.successes, t.successes) < MIN_SUCCESSES;

/** Treatment against control on one rate, read the plan's way. */
export function compareArms(c: ArmCounts, t: ArmCounts): Comparison {
  const controlRate = rate(c);
  const treatmentRate = rate(t);
  const none: Comparison = {
    controlRate,
    treatmentRate,
    lift: null,
    low: null,
    high: null,
    margin: null,
    notWorseAt: null,
    pBetter: null,
    pBetterTarget: null,
    safety: null,
    significant: false,
    verdict: "few",
  };
  if (controlRate === 0 || t.total === 0) return none;

  const lift = treatmentRate / controlRate - 1;
  const se = liftSe(controlRate, c.total, t.total);
  const significant = lift - Z_95_ONE_SIDED * se > 0;
  const safety: Safety =
    lift < -Z_95_ONE_SIDED * se
      ? "worse"
      : lift >= nonInferiorityBar(se)
        ? "notWorse"
        : "open";
  // The log of a zero rate has no range: wait for a conversion.
  const seLog =
    treatmentRate > 0
      ? logRatioSe(controlRate, c.total, treatmentRate, t.total)
      : null;
  const range = seLog === null ? null : logInterval(lift, seLog);
  const verdict: Verdict = isFew(c, t)
    ? "few"
    : significant
      ? "better"
      : safety === "worse"
        ? "worse"
        : safety === "notWorse"
          ? "notWorse"
          : "unclear";
  return {
    controlRate,
    treatmentRate,
    lift,
    low: range?.[0] ?? null,
    high: range?.[1] ?? null,
    margin: Z_95 * se,
    notWorseAt: nonInferiorityBar(se),
    pBetter: seLog === null ? null : confidenceAbove(lift, 0, seLog),
    pBetterTarget:
      seLog === null ? null : confidenceAbove(lift, TARGET_LIFT, seLog),
    safety,
    significant,
    verdict,
  };
}

export interface MarginForecast {
  /** More days at the traffic and split so far. */
  days: number;
  /** Exposed visitor-days those days bring, both arms. */
  exposed: number;
  /** More days if the same traffic were split 50/50 from now on. */
  evenSplitDays: number;
}

/**
 * When the lift's margin narrows to ±`target`: the margin shrinks with the
 * square root of the days (plan §3), at each arm's pace over the `days` so
 * far. Null without days or a base rate.
 */
export function daysToMargin(
  c: ArmCounts,
  t: ArmCounts,
  days: number,
  target: number,
): MarginForecast | null {
  const controlRate = rate(c);
  if (days <= 0 || controlRate === 0 || t.total === 0) return null;
  const margin = Z_95 * liftSe(controlRate, c.total, t.total);
  const needed = days * (margin / target) ** 2;
  const more = Math.max(0, Math.ceil(needed - days));
  const share = t.total / (c.total + t.total);
  return {
    days: more,
    exposed: Math.round(((c.total + t.total) / days) * more),
    evenSplitDays: Math.max(0, Math.ceil((needed - days) / splitCost(share))),
  };
}

export interface DayCounts {
  date: string;
  counts: ArmCounts;
}

export interface LiftPoint {
  date: string;
  lift: number | null;
  low: number | null;
  high: number | null;
}

/** The lift and its 95% range with every day so far added up, day by day. */
export function cumulativeLift(
  control: DayCounts[],
  test: DayCounts[],
): LiftPoint[] {
  const dates = [...new Set([...control, ...test].map((d) => d.date))].sort();
  const sum = { c: { successes: 0, total: 0 }, t: { successes: 0, total: 0 } };
  return dates.map((date) => {
    for (const [arm, days] of [
      [sum.c, control],
      [sum.t, test],
    ] as const) {
      const day = days.find((d) => d.date === date);
      arm.successes += day?.counts.successes ?? 0;
      arm.total += day?.counts.total ?? 0;
    }
    const r = compareArms(sum.c, sum.t);
    return { date, lift: r.lift, low: r.low, high: r.high };
  });
}

const AXIS_STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5];

/** A lift axis on round steps that holds `values`, zero and the −2% line. */
export function liftAxis(values: number[]): {
  min: number;
  max: number;
  ticks: number[];
} {
  const all = [...values, 0, NON_INFERIORITY];
  const pad = (Math.max(...all) - Math.min(...all)) * 0.04;
  const lo = Math.min(...all) - pad;
  const hi = Math.max(...all) + pad;
  const step =
    AXIS_STEPS.find((s) => (hi - lo) / s <= 6) ?? AXIS_STEPS.at(-1) ?? 1;
  const from = Math.floor(lo / step);
  const to = Math.ceil(hi / step);
  const round = (k: number) => Math.round(k * step * 1e9) / 1e9 || 0;
  return {
    min: round(from),
    max: round(to),
    ticks: Array.from({ length: to - from + 1 }, (_, i) => round(from + i)),
  };
}

/** Whole days since `startedAt`, at least 1 once it has started. */
export function daysRunning(startedAt: string | null, now: number): number {
  const start = Date.parse(startedAt ?? "");
  if (!Number.isFinite(start) || start > now) return 0;
  return Math.max(1, Math.ceil((now - start) / 86_400_000));
}
