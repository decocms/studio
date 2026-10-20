/**
 * One store's day in the customer lake, as the order rules read it: orders by
 * creation time, cancellations and payment denials by when they happened, per
 * 15-minute bucket of the store's local day, for day 0 and the days the rules
 * compare it with. The sweep reads it at its scheduled time; the Monitor UI
 * reads the same function, so the chart shows what the sweep judged.
 *
 * Runs as the org's own lake user, so the row policy applies.
 */

import { queryCustomerLake } from "../customer-lake/client";
import {
  BUCKETS_PER_DAY,
  DAYS_AGO,
  type DayAgo,
  type DaySeries,
  type StoreDay,
} from "./order-rules";

/** A bucket counts once it ended this long before `at`: hook → queue → VTEX fetch → insert, with queue retries. */
const INGEST_GRACE_MIN = 5;

const AT = "{at:DateTime64(3, 'UTC')}";
const daysAgo = (col: string) =>
  `dateDiff('day', toDate(${col}, {tz:String}), toDate(${AT}, {tz:String}))`;
const bucket = (col: string) =>
  `intDiv(toHour(${col}, {tz:String}) * 60 + toMinute(${col}, {tz:String}), 15)`;
// Two ranges keep Y-1 to two days of scan instead of a year.
const inRange = (col: string) => `${col} < ${AT}
    AND (${col} >= ${AT} - INTERVAL 30 DAY
         OR ${col} BETWEEN ${AT} - INTERVAL 365 DAY AND ${AT} - INTERVAL 363 DAY)
    AND days_ago IN (${DAYS_AGO.join(", ")})`;

// FINAL: `orders` replaces on `version`, so an order that went paid → canceled
// would otherwise count twice. Every created order counts, whatever its status now.
const ORDERS_SQL = `
  SELECT ${daysAgo("created_at")} AS days_ago, ${bucket("created_at")} AS bucket, count() AS placed
  FROM customer_lake.orders FINAL
  WHERE connection_id = {conn:String} AND ${inRange("created_at")}
  GROUP BY days_ago, bucket`;

// uniqExact absorbs hook retries that wrote the same event twice.
const EVENTS_SQL = `
  SELECT ${daysAgo("changed_at")} AS days_ago, ${bucket("changed_at")} AS bucket,
    uniqExactIf(order_id, status = 'canceled' AND source_status != 'payment-denied') AS canceled,
    uniqExactIf(order_id, source_status = 'payment-denied') AS denied
  FROM customer_lake.order_events
  WHERE connection_id = {conn:String} AND ${inRange("changed_at")}
  GROUP BY days_ago, bucket`;

// Chart only, for reference days before the install's first event:
// `updated_at` is an order's last change, which for a canceled order is usually
// the cancellation but can be a later refund, so it skews late.
const APPROX_CANCELS_SQL = `
  SELECT ${daysAgo("updated_at")} AS days_ago, ${bucket("updated_at")} AS bucket,
    countIf(source_status != 'payment-denied') AS canceled,
    countIf(source_status = 'payment-denied') AS denied
  FROM customer_lake.orders FINAL
  WHERE connection_id = {conn:String}
    AND (status = 'canceled' OR source_status = 'payment-denied')
    AND ${inRange("updated_at")}
  GROUP BY days_ago, bucket`;

// `order_events` starts at the install (backfill writes only `orders`).
const FIRST_EVENT_SQL = `
  SELECT ${daysAgo("minOrNull(changed_at)")} AS days_ago
  FROM customer_lake.order_events
  WHERE connection_id = {conn:String} AND changed_at < ${AT}`;

const TIMEZONE_SQL = `
  SELECT timezone FROM customer_lake.connections FINAL
  WHERE connection_id = {conn:String} LIMIT 1`;

/** ClickHouse's DateTime64 text form, in UTC. */
function toLakeTime(at: Date): string {
  return at.toISOString().replace("T", " ").replace("Z", "");
}

/** Minutes since local midnight in `timezone`. */
export function localMinutes(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  return part("hour") * 60 + part("minute");
}

/** The zone's UTC offset at `t`, in minutes. */
function utcOffset(t: Date, timezone: string): number {
  const name =
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "longOffset",
    })
      .formatToParts(t)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

/** The instant the local day containing `at` started, DST switches included. */
export function localDayStart(at: Date, timezone: string): Date {
  const intoMinute = at.getTime() % 60_000;
  const guess = at.getTime() - localMinutes(at, timezone) * 60_000 - intoMinute;
  const shift = utcOffset(at, timezone) - utcOffset(new Date(guess), timezone);
  return new Date(guess + shift * 60_000);
}

/** The instant 15-minute `bucket` of `at`'s local day started (negative: the day before), counted back from `at`. */
export function localBucketStart(
  at: Date,
  timezone: string,
  bucket: number,
): Date {
  const intoMinute = at.getTime() % 60_000;
  return new Date(
    at.getTime() -
      (localMinutes(at, timezone) - bucket * 15) * 60_000 -
      intoMinute,
  );
}

/** Buckets of `at`'s local day before it that a DST switch skipped or repeated. */
export function dstBuckets(at: Date, timezone: string): number[] {
  const DAY = 24 * 60 * 60_000;
  const since = at.getTime() - DAY - 2 * 60 * 60_000;
  if (utcOffset(new Date(since), timezone) === utcOffset(at, timezone)) {
    return [];
  }
  const day = (t: Date) =>
    t.toLocaleDateString("en-CA", { timeZone: timezone });
  const today = day(at);
  const current = Math.floor(localMinutes(at, timezone) / 15);
  const hits = new Array<number>(BUCKETS_PER_DAY).fill(0);
  for (let t = since; t < at.getTime(); t += 15 * 60_000) {
    const d = new Date(t);
    if (day(d) !== today) continue;
    const b = Math.floor(localMinutes(d, timezone) / 15);
    hits[b] = (hits[b] ?? 0) + 1;
  }
  return hits.flatMap((n, b) => (b < current && n !== 1 ? [b] : []));
}

/** Buckets of the local day that ended at least INGEST_GRACE_MIN before `at`. */
export function doneBuckets(at: Date, timezone: string): number {
  const minutes = localMinutes(at, timezone);
  return Math.max(0, Math.floor((minutes - INGEST_GRACE_MIN) / 15));
}

function emptyDays(): Record<DayAgo, DaySeries> {
  const zeros = () => new Array<number>(BUCKETS_PER_DAY).fill(0);
  return Object.fromEntries(
    DAYS_AGO.map((d) => [
      d,
      { placed: zeros(), canceled: zeros(), denied: zeros() },
    ]),
  ) as Record<DayAgo, DaySeries>;
}

/** The store's IANA zone, or null when the lake has none for it. */
export async function loadStoreTimezone(
  organizationId: string,
  connectionId: string,
): Promise<string | null> {
  const [row] = await queryCustomerLake(organizationId, TIMEZONE_SQL, {
    conn: connectionId,
  });
  return typeof row?.timezone === "string" && row.timezone
    ? row.timezone
    : null;
}

/**
 * The store's day at `at`, or null when the lake has no timezone for it (the
 * ingest worker's zone map needs an entry). Nothing at or after `at` is read,
 * so a replayed tick gets the same answer. `approximate` adds the chart's
 * stand-in for cancellations before the install; the rules never read it.
 */
export async function loadStoreDay(
  organizationId: string,
  connectionId: string,
  at: Date,
  opts: { approximate?: boolean } = {},
): Promise<StoreDay | null> {
  const timezone = await loadStoreTimezone(organizationId, connectionId);
  if (!timezone) return null;

  const params = { conn: connectionId, tz: timezone, at: toLakeTime(at) };
  const [orders, events, [first], approx] = await Promise.all([
    queryCustomerLake(organizationId, ORDERS_SQL, params),
    queryCustomerLake(organizationId, EVENTS_SQL, params),
    queryCustomerLake(organizationId, FIRST_EVENT_SQL, params),
    opts.approximate
      ? queryCustomerLake(organizationId, APPROX_CANCELS_SQL, params)
      : null,
  ]);

  const days = emptyDays();
  // Counts come back as strings (UInt64 in JSONEachRow).
  const cell = (row: Record<string, unknown>) => {
    const day = days[Number(row.days_ago) as DayAgo];
    const b = Number(row.bucket);
    return day && b >= 0 && b < BUCKETS_PER_DAY ? { day, b } : null;
  };
  for (const row of orders) {
    const c = cell(row);
    if (c) c.day.placed[c.b] = Number(row.placed);
  }
  for (const row of events) {
    const c = cell(row);
    if (!c) continue;
    c.day.canceled[c.b] = Number(row.canceled);
    c.day.denied[c.b] = Number(row.denied);
  }
  let approximate: StoreDay["approximate"];
  if (approx) {
    const approxDays = emptyDays();
    for (const row of approx) {
      const day = approxDays[Number(row.days_ago) as DayAgo];
      const b = Number(row.bucket);
      if (!day || b < 0 || b >= BUCKETS_PER_DAY) continue;
      day.canceled[b] = Number(row.canceled);
      day.denied[b] = Number(row.denied);
    }
    approximate = approxDays;
  }

  return {
    timezone,
    done: doneBuckets(at, timezone),
    days,
    dstBuckets: dstBuckets(at, timezone),
    firstEventDaysAgo:
      first?.days_ago === null || first?.days_ago === undefined
        ? null
        : Number(first.days_ago),
    approximate,
  };
}
