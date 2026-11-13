/**
 * Core Web Vitals thresholds and Google's assessment, as the Deco Analytics
 * dashboard applies them: an origin passes only when LCP, INP and CLS are all
 * good at p75. TTFB and FCP are shown but never decide the verdict.
 */

export const VITALS = ["lcp", "inp", "cls", "ttfb", "fcp"] as const;
export type Vital = (typeof VITALS)[number];

export const CORE_VITALS: ReadonlyArray<Vital> = ["lcp", "inp", "cls"];

export const VITAL_META: Record<
  Vital,
  { good: number; poor: number; unit: "ms" | ""; label: string }
> = {
  lcp: { good: 2500, poor: 4000, unit: "ms", label: "LCP" },
  inp: { good: 200, poor: 500, unit: "ms", label: "INP" },
  cls: { good: 0.1, poor: 0.25, unit: "", label: "CLS" },
  ttfb: { good: 800, poor: 1800, unit: "ms", label: "TTFB" },
  fcp: { good: 1800, poor: 3000, unit: "ms", label: "FCP" },
};

/** The read surface's band names (`vitalsBands`, `conversionBySpeed`). */
export const BANDS = ["good", "needs work", "poor"] as const;
export type Band = (typeof BANDS)[number];

export function asBand(value: unknown): Band | null {
  return BANDS.find((b) => b === value) ?? null;
}

function asVital(value: unknown): Vital | null {
  return VITALS.find((v) => v === value) ?? null;
}

/** A missing measurement is no band at all, never "good". */
export function bandOf(vital: Vital, value: number | null): Band | null {
  if (value === null || !Number.isFinite(value)) return null;
  const m = VITAL_META[vital];
  return value <= m.good ? "good" : value <= m.poor ? "needs work" : "poor";
}

export type Assessment = "passing" | "failing" | "incomplete";

export function assess(p75: Record<Vital, number | null>): {
  verdict: Assessment;
  missing: Vital[];
} {
  const missing = CORE_VITALS.filter((v) => bandOf(v, p75[v]) === null);
  if (missing.length) return { verdict: "incomplete", missing };
  const passes = CORE_VITALS.every((v) => bandOf(v, p75[v]) === "good");
  return { verdict: passes ? "passing" : "failing", missing };
}

export type BandCounts = Record<Band, number>;

/** `vitalsBands` rows → counts per metric and band. */
export function bandCounts(
  rows: ReadonlyArray<{ metric: unknown; band: unknown; n: unknown }>,
): Record<Vital, BandCounts> {
  const out = Object.fromEntries(
    VITALS.map((v) => [v, { good: 0, "needs work": 0, poor: 0 }]),
  ) as Record<Vital, BandCounts>;
  for (const r of rows) {
    const v = asVital(r.metric);
    const b = asBand(r.band);
    const n = Number(r.n);
    if (v && b && Number.isFinite(n)) out[v][b] += n;
  }
  return out;
}
