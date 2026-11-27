/**
 * The plan engine's 0–1 confidence in the three levels the Plan page shows.
 * The page's ranking reads the same levels, so the order matches the labels.
 */

export type ConfidenceLevel = "high" | "medium" | "low";

export function confidenceLevel(confidence: number): ConfidenceLevel | null {
  if (!Number.isFinite(confidence)) return null;
  if (confidence >= 0.7) return "high";
  if (confidence >= 0.4) return "medium";
  return "low";
}

const LEVEL_WEIGHT: Record<ConfidenceLevel, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/** Confidence level first; within a level, more money a month, then the
 *  higher raw confidence. An estimate without money goes after those with. */
export function byConfidenceThenValue(
  a: { money: { monthly_value: number } | null; confidence: number },
  b: { money: { monthly_value: number } | null; confidence: number },
): number {
  const level = (c: number) => {
    const l = confidenceLevel(c);
    return l ? LEVEL_WEIGHT[l] : 0;
  };
  return (
    level(b.confidence) - level(a.confidence) ||
    (b.money?.monthly_value ?? -1) - (a.money?.monthly_value ?? -1) ||
    (Number.isFinite(b.confidence) ? b.confidence : -1) -
      (Number.isFinite(a.confidence) ? a.confidence : -1)
  );
}
