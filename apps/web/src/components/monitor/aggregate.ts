/**
 * How a per-site average reads across several sites: weighted by each site's
 * size (a rate over sessions is weighted by sessions, a cache rate by
 * requests), with the spread between sites kept in view so the total never
 * hides which site pulls it up or down.
 */

export interface SiteValue {
  title: string;
  value: number;
  /** What the value is an average over: sessions, requests. */
  weight: number;
}

/** The weighted mean, or null when no site has any weight. */
export function weightedMean(values: readonly SiteValue[]): number | null {
  const total = values.reduce((n, v) => n + v.weight, 0);
  if (total <= 0) return null;
  return values.reduce((n, v) => n + v.value * v.weight, 0) / total;
}

/**
 * Up to three sites spelled out; more than that, only the best and the worst,
 * where "best" is the lowest value when `lowerIsBetter`.
 */
export function spread(
  values: readonly SiteValue[],
  format: (value: number) => string,
  lowerIsBetter: boolean,
):
  | { kind: "all"; items: string[] }
  | { kind: "range"; best: string; worst: string }
  | null {
  if (values.length < 2) return null;
  if (values.length <= 3) {
    return {
      kind: "all",
      items: values.map((v) => `${v.title} ${format(v.value)}`),
    };
  }
  const sorted = [...values].sort((a, b) =>
    lowerIsBetter ? a.value - b.value : b.value - a.value,
  );
  const best = sorted[0];
  const worst = sorted.at(-1);
  if (!best || !worst) return null;
  return {
    kind: "range",
    best: `${best.title} ${format(best.value)}`,
    worst: `${worst.title} ${format(worst.value)}`,
  };
}
