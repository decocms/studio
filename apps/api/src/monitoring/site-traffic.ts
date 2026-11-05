/**
 * The org's site traffic for the Monitor's Audience card, from
 * `customer_lake.site_traffic_hourly` (Deco Analytics, synced into the lake).
 * Read as the org's own lake user, so the row policy already limits it to the
 * org's sites; `siteId` narrows to one of them.
 */

import type { SiteTrafficDay } from "@decocms/shared/order-monitor";
import { queryCustomerLake } from "../customer-lake/client";

const AT = "{at:DateTime64(3, 'UTC')}";
/** Today, D-1, W-1 and Y-1 (same weekday), like the orders card. */
const DAYS_AGO = { today: 0, d1: 1, w1: 7, y1: 364 } as const;

const WHERE = `
  hour <= ${AT}
  AND (hour >= ${AT} - INTERVAL 8 DAY
       OR hour BETWEEN ${AT} - INTERVAL 366 DAY AND ${AT} - INTERVAL 362 DAY)
  AND ({site:String} = '' OR site_id = {site:String})`;
const daysAgo = `dateDiff('day', toDate(hour, {tz:String}), toDate(${AT}, {tz:String}))`;

// Visitors are a uniq state: merged per hour for the line, and per day (never
// summed from the hours) for the headline.
const HOURLY_SQL = `
  SELECT ${daysAgo} AS days_ago, toHour(hour, {tz:String}) AS h,
    uniqMerge(visitors) AS visitors, sum(conversions) AS conversions
  FROM customer_lake.site_traffic_hourly FINAL
  WHERE ${WHERE}
  GROUP BY days_ago, h`;

// A reference day counts up to the same hour of the day as now.
const HEADLINE_SQL = `
  SELECT ${daysAgo} AS days_ago, uniqMerge(visitors) AS visitors, sum(conversions) AS conversions
  FROM customer_lake.site_traffic_hourly FINAL
  WHERE ${WHERE} AND toHour(hour, {tz:String}) <= toHour(${AT}, {tz:String})
  GROUP BY days_ago`;

/** The local day of `at` in `timezone`; null when no site has synced a row in its window. */
export async function loadSiteTraffic(
  organizationId: string,
  at: Date,
  timezone: string,
  siteId: string,
): Promise<SiteTrafficDay | null> {
  const params = {
    at: at.toISOString().replace("T", " ").replace("Z", ""),
    tz: timezone,
    site: siteId,
  };
  const [hourly, headline] = await Promise.all([
    queryCustomerLake(organizationId, HOURLY_SQL, params),
    queryCustomerLake(organizationId, HEADLINE_SQL, params),
  ]);
  if (hourly.length === 0) return null;

  type Measure = "visitors" | "conversions";
  const series = (measure: Measure, day: number) => {
    const out = new Array<number>(24).fill(0);
    for (const row of hourly) {
      if (Number(row.days_ago) === day)
        out[Number(row.h)] = Number(row[measure]);
    }
    return out;
  };
  const nowHour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(at),
  );
  const day = (measure: Measure) => ({
    today: series(measure, DAYS_AGO.today).map((v, h) =>
      h <= nowHour ? v : null,
    ),
    d1: series(measure, DAYS_AGO.d1),
    w1: series(measure, DAYS_AGO.w1),
    y1: series(measure, DAYS_AGO.y1),
  });
  const total = (measure: Measure) => {
    const of = (d: number) =>
      Number(headline.find((r) => Number(r.days_ago) === d)?.[measure] ?? 0);
    return {
      today: of(DAYS_AGO.today),
      d1: of(DAYS_AGO.d1),
      w1: of(DAYS_AGO.w1),
      y1: of(DAYS_AGO.y1),
    };
  };

  return {
    visitors: day("visitors"),
    conversions: day("conversions"),
    headline: {
      visitors: total("visitors"),
      conversions: total("conversions"),
    },
  };
}
