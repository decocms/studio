/**
 * A/B test statistics — server-side port of the deco.cx admin util
 * (`deco-sites/admin/utils/statistics/abTest.ts`, and the admin-mcp port in
 * `decocms/admin-mcp/api/lib/ab-test.ts`). The Experiments results tool computes
 * these numbers so the UI only renders them.
 *
 * The admin version depends on `jstat` only for `jStat.normal.cdf`. We instead
 * reimplement the standard-normal CDF with an Abramowitz & Stegun erf
 * approximation (formula 7.1.26, |error| < 1.5e-7) and keep the rest identical.
 */

export interface Variant {
  /** Number of successes (e.g. conversions for the selected goal). */
  successes: number;
  /** Total participants (e.g. visitors that saw this variant). */
  total: number;
}

/** alpha = 0.05, one-sided. */
const Z_ALPHA = 1.644853;
/** beta = 0.2, one-sided. */
const Z_BETA = 0.8416;
const MIN_SAMPLE_SIZE = 1000;

/**
 * Standard-normal cumulative distribution function. Drop-in replacement for
 * `jStat.normal.cdf(x, mean, std)`.
 */
export function normalCdf(x: number, mean = 0, std = 1): number {
  const z = (x - mean) / (std * Math.SQRT2);
  // erf approximation — Abramowitz & Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-z * z);
  const erf = z >= 0 ? y : -y;
  return 0.5 * (1 + erf);
}

function proportion(a: Variant): number {
  return a.successes / a.total;
}

function standardError(a: Variant): number {
  const p = proportion(a);
  return Math.sqrt((p * (1 - p)) / a.total);
}

/**
 * Probability that a random sample from B is greater than one from A — i.e. the
 * chance the test variant beats the default.
 */
export function pBetter(a: Variant, b: Variant): number {
  const z =
    -(proportion(b) - proportion(a)) /
    Math.sqrt(standardError(a) ** 2 + standardError(b) ** 2);
  const result = 1 - normalCdf(z, 0, 1);
  return Number.isFinite(result) ? result : 0;
}

/**
 * Required sample size to reach significance. Based on Wiley Series in
 * Probability and Statistics, Chapter 4. Returns `null` when there isn't enough
 * data yet to establish a control.
 */
export function sampleSize(a: Variant, b: Variant, mde = 0.03): number | null {
  // not enough data to establish a control for the sample size calculation
  if (a.total < MIN_SAMPLE_SIZE || a.successes === 0) {
    return null;
  }

  const r = b.total / a.total;

  const p1 = proportion(a);
  // use MDE if variant B's proportion would cause a sample size that is too large
  const p2 = Math.max(p1 * (1 + mde), proportion(b));
  const p = (p1 + r * p2) / (r + 1);

  const numerator =
    Z_ALPHA * Math.sqrt((r + 1) * p * (1 - p)) +
    Z_BETA * Math.sqrt(r * p1 * (1 - p1) + p2 * (1 - p2));
  const denominator = p2 - p1;
  const sampleSizeRaw = (numerator / denominator) ** 2 / r;

  const mul =
    1 + Math.sqrt(1 + (2 * (r + 1)) / (sampleSizeRaw * r * Math.abs(p1 - p2)));

  const size = (sampleSizeRaw * mul ** 2) / 4;

  return Math.ceil(size) * (1 + r);
}
