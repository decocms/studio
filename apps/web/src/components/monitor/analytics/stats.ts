/**
 * The experiment verdict, ported from the Deco Analytics dashboard
 * (`dashboard/stats.mjs`) so the Monitor and the dashboard can't disagree on
 * whether a variant won.
 *
 * A two-proportion z-test on converting visitors. It is fixed-horizon, and the
 * screen is looked at repeatedly, so false positives inflate well past 5%: the
 * UI says so beside every verdict.
 */

export type AbState = "win" | "loss" | "inconclusive" | "none";

export interface AbArm {
  visitors: number;
  converters: number;
}

export interface AbResult {
  state: AbState;
  /** Relative change of the variant's conversion rate over control's. */
  lift: number | null;
  p: number | null;
  /** Fewer than {@link MIN_CONVERSIONS} conversions in an arm. */
  thin: boolean;
  /** 95% interval of the conversion-rate difference (variant − control). */
  ciLo: number | null;
  ciHi: number | null;
}

/** A per-arm floor: below it a p under 0.05 is as likely noise as an effect. */
const MIN_CONVERSIONS = 30;

/** Abramowitz–Stegun 7.1.26, the same approximation the dashboard uses. */
export function erf(x: number): number {
  const s = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-a * a);
  return s * y;
}

export function phi(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

export function abTest(control: AbArm, variant: AbArm): AbResult {
  const n1 = control.visitors;
  const c1 = control.converters;
  const n2 = variant.visitors;
  const c2 = variant.converters;
  if (!n1 || !n2) {
    return {
      state: "none",
      lift: null,
      p: null,
      thin: true,
      ciLo: null,
      ciHi: null,
    };
  }
  const p1 = c1 / n1;
  const p2 = c2 / n2;
  const pooled = (c1 + c2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  const seDiff = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  const z = se ? (p2 - p1) / se : 0;
  const p = 2 * (1 - phi(Math.abs(z)));
  const thin = Math.min(c1, c2) < MIN_CONVERSIONS;
  return {
    state: thin || p > 0.05 ? "inconclusive" : z > 0 ? "win" : "loss",
    lift: p1 ? (p2 - p1) / p1 : null,
    p,
    thin,
    ciLo: p2 - p1 - 1.96 * seDiff,
    ciHi: p2 - p1 + 1.96 * seDiff,
  };
}

const CONTROL_NAMES = new Set(["control", "a", "0", "baseline"]);

/** The arm the others are compared with: a conventional name, else the first. */
export function controlIndex(variants: ReadonlyArray<string>): number {
  const i = variants.findIndex((v) => CONTROL_NAMES.has(v.toLowerCase()));
  return i < 0 ? 0 : i;
}
