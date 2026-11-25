/**
 * What the site traffic sweep reads from `customer_lake.site_traffic_hourly`:
 * the org's sites with recent traffic, and one site's hours for the judged day
 * and its reference days. Runs as the org's own lake user, so the row policy
 * keeps it to the org's sites.
 */

import { queryCustomerLake } from "../customer-lake/client";
import { TRAFFIC_BASELINE_DAYS, type TrafficDay } from "./traffic-rules";

/** An hour is judged once it ended this long ago and the lake has moved past it: late events keep landing. */
const GRACE_MIN = 10;

const AT = "{at:DateTime64(3, 'UTC')}";

const SITES_SQL = `
  SELECT site_id FROM customer_lake.site_traffic_hourly FINAL
  WHERE hour >= ${AT} - INTERVAL 1 DAY AND hour < ${AT}
  GROUP BY site_id`;

// The day of the judged hour and its reference days, by local clock hour.
const DAYS = [0, ...TRAFFIC_BASELINE_DAYS];
const START = "{start:DateTime64(3, 'UTC')}";
const HOURS_SQL = `
  SELECT dateDiff('day', toDate(hour, {tz:String}), toDate(${START}, {tz:String})) AS days_ago,
    toHour(hour, {tz:String}) AS h, uniqMerge(visitors) AS visitors, sum(pageviews) AS pageviews
  FROM customer_lake.site_traffic_hourly FINAL
  WHERE site_id = {site:String}
    AND hour <= ${START} AND hour >= ${START} - INTERVAL ${Math.max(...DAYS) + 2} DAY
    AND days_ago IN (${DAYS.join(", ")})
  GROUP BY days_ago, h`;

const NEWEST_SQL = `
  SELECT toUnixTimestamp(max(hour)) AS newest FROM customer_lake.site_traffic_hourly
  WHERE hour >= ${AT} - INTERVAL 1 DAY AND hour <= ${AT}`;

// Any zone the org's lake rows carry (a store's, a GA property's).
const TIMEZONE_SQL = `
  SELECT timezone FROM customer_lake.connections FINAL
  WHERE timezone != '' ORDER BY connection_id LIMIT 1`;

const toLake = (at: Date) =>
  at.toISOString().replace("T", " ").replace("Z", "");

export async function listTrafficSites(
  organizationId: string,
  at: Date,
): Promise<string[]> {
  const rows = await queryCustomerLake(organizationId, SITES_SQL, {
    at: toLake(at),
  });
  return rows.map((r) => String(r.site_id));
}

export async function loadOrgTimezone(organizationId: string): Promise<string> {
  const [row] = await queryCustomerLake(organizationId, TIMEZONE_SQL);
  return typeof row?.timezone === "string" && row.timezone
    ? row.timezone
    : "UTC";
}

/** One sweep's newest lake hour, shared by its org steps so it costs one read per org. */
let newest: { at: number; hour: Promise<number> } | null = null;

/**
 * Whether the lake holds traffic from after `hourStart` for any of the orgs'
 * sites. The sync copies the analytics warehouse every minute, so a fresh
 * `synced_at` says nothing when the warehouse itself runs behind; the next
 * hour having arrived does, and an hour judged before it reads as a drop.
 * Read across every org so a site that went dark can't hold back its own alert.
 */
export async function lakeHasPassed(
  organizationIds: readonly string[],
  at: Date,
  hourStart: Date,
): Promise<boolean> {
  if (newest?.at !== at.getTime()) {
    const read = (id: string) =>
      queryCustomerLake(id, NEWEST_SQL, { at: toLake(at) }).then(
        ([row]) => Number(row?.newest ?? 0) * 1000,
        () => 0,
      );
    newest = {
      at: at.getTime(),
      hour: Promise.all(organizationIds.map(read)).then((hs) =>
        Math.max(0, ...hs),
      ),
    };
  }
  return (await newest.hour) > hourStart.getTime();
}

/** The last hour that ended at least `GRACE_MIN` before `at`: its start, and its clock hour in `timezone`. */
export function judgedHour(at: Date, timezone: string) {
  const end = at.getTime() - GRACE_MIN * 60_000;
  const hourStart = new Date(
    Math.floor(end / 3_600_000) * 3_600_000 - 3_600_000,
  );
  const hour = Number(
    hourStart.toLocaleString("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      hourCycle: "h23",
    }),
  );
  return { hour, hourStart };
}

const empty = (): TrafficDay => ({
  visitors: new Array<number>(24).fill(0),
  pageviews: new Array<number>(24).fill(0),
});

/** The judged hour's day up to that hour, and its reference days with any traffic. */
export async function loadTrafficDays(
  organizationId: string,
  siteId: string,
  timezone: string,
  hourStart: Date,
): Promise<{ today: TrafficDay; refs: TrafficDay[] }> {
  const rows = await queryCustomerLake(organizationId, HOURS_SQL, {
    start: toLake(hourStart),
    tz: timezone,
    site: siteId,
  });
  const days = new Map<number, TrafficDay>(DAYS.map((d) => [d, empty()]));
  for (const r of rows) {
    const day = days.get(Number(r.days_ago));
    const h = Number(r.h);
    if (!day || h < 0 || h > 23) continue;
    day.visitors[h] = Number(r.visitors);
    day.pageviews[h] = Number(r.pageviews);
  }
  return {
    today: days.get(0)!,
    refs: TRAFFIC_BASELINE_DAYS.map((d) => days.get(d)!).filter((d) =>
      d.visitors.some((v) => v > 0),
    ),
  };
}
