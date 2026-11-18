/**
 * Site traffic rules, pure. Like `orders_drop`, each compares the last
 * complete hour of a site's local day with the median of the same hour on
 * D-1 and W-1..W-4 (those with traffic), scaled by how the day's earlier hours
 * ran against theirs, so a campaign day doesn't read as everything else
 * dropping.
 */

import {
  SITE_TRAFFIC_DEFAULT_THRESHOLDS,
  type SiteTrafficRule,
  type SiteTrafficThresholds,
} from "@decocms/shared/alerts";

/** Days back from the judged day that make the baseline. */
export const TRAFFIC_BASELINE_DAYS = [1, 7, 14, 21, 28] as const;
/** Earlier hours with a baseline the day needs before its level is trusted. */
const MIN_LEVEL_BASE = 5;
/** How far the day's level may scale the baseline either way. */
const LEVEL_MIN = 0.5;
const LEVEL_MAX = 2;

export type TrafficMeasure = "visitors" | "pageviews";
const MEASURE_OF: Record<SiteTrafficRule, TrafficMeasure> = {
  visitors_drop: "visitors",
  pageviews_drop: "pageviews",
};

/** One local day of a site: per clock hour (24 entries) of each measure. */
export type TrafficDay = Record<TrafficMeasure, number[]>;

export interface TrafficVerdict {
  status: "ok" | "alert" | "low-volume";
  /** The judged clock hour of the day. */
  hour: number;
  observed: number;
  expected: number;
  alertAt: number;
  level: number;
}

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** How the day ran before `hour` against the baseline: the base-weighted median of the hourly ratios. */
function level(today: number[], refs: number[][], hour: number): number {
  const hours = Array.from({ length: hour }, (_, h) => ({
    base: median(refs.map((r) => r[h] ?? 0)),
    today: today[h] ?? 0,
  })).filter((x) => x.base > 0);
  const total = sum(hours.map((x) => x.base));
  if (hours.length < MIN_LEVEL_BASE || total === 0) return 1;
  const ranked = hours.sort((x, y) => x.today / x.base - y.today / y.base);
  let acc = 0;
  for (const x of ranked) {
    acc += x.base;
    if (acc >= total / 2) {
      return Math.min(LEVEL_MAX, Math.max(LEVEL_MIN, x.today / x.base));
    }
  }
  return 1;
}

/**
 * Every rule's verdict for `hour` of `today`. `refs` are the reference days
 * (`TRAFFIC_BASELINE_DAYS`) with any traffic at all: a day the lake never saw
 * would drag the median to nothing.
 */
export function evaluateTraffic(
  today: TrafficDay,
  refs: TrafficDay[],
  hour: number,
  thresholds: SiteTrafficThresholds = SITE_TRAFFIC_DEFAULT_THRESHOLDS,
): Record<SiteTrafficRule, TrafficVerdict> {
  const verdict = (rule: SiteTrafficRule): TrafficVerdict => {
    const m = MEASURE_OF[rule];
    const days = refs.map((r) => r[m]);
    const lv = level(today[m], days, hour);
    const expected = lv * median(days.map((d) => d[hour] ?? 0));
    const observed = today[m][hour] ?? 0;
    const { threshold, minVolume } = thresholds[rule];
    const alertAt = (threshold / 100) * expected;
    return {
      status:
        expected < minVolume
          ? "low-volume"
          : observed < alertAt
            ? "alert"
            : "ok",
      hour,
      observed,
      expected,
      alertAt,
      level: lv,
    };
  };
  return {
    visitors_drop: verdict("visitors_drop"),
    pageviews_drop: verdict("pageviews_drop"),
  };
}
