/**
 * The numbers Jev reads to pick the store goal: the last 28 days against the
 * 28 before, from the org's own data lake (Deco Analytics traffic, the GA4
 * funnel, and orders). Read as the org's lake user, so the row policy limits
 * every query to the org's rows.
 */

import type { StoreSnapshot } from "@decocms/shared/organization/schema";
import {
  isCustomerLakeConfigured,
  queryCustomerLake,
} from "../../customer-lake/client";

const WINDOW_DAYS = 28;
const DAY_MS = 86_400_000;

const TRAFFIC_SQL = `
  SELECT
    uniqMergeIf(visitors, hour >= {from:DateTime}) AS cur_visitors,
    uniqMergeIf(visitors, hour < {from:DateTime}) AS prev_visitors,
    uniqMergeIf(visitors, hour >= {from:DateTime} AND device = 'mobile') AS mobile_visitors,
    sumIf(conversions, hour >= {from:DateTime} AND device = 'mobile') AS mobile_conversions,
    uniqMergeIf(visitors, hour >= {from:DateTime} AND device = 'desktop') AS desktop_visitors,
    sumIf(conversions, hour >= {from:DateTime} AND device = 'desktop') AS desktop_conversions,
    sumIf(pageviews, hour >= {from:DateTime}) AS cur_pageviews,
    sumIf(errors, hour >= {from:DateTime}) AS cur_errors,
    count() AS row_count,
    toString(min(hour)) AS first
  FROM customer_lake.site_traffic_hourly FINAL
  WHERE hour >= {prevFrom:DateTime}`;

const FUNNEL_SQL = `
  SELECT dims['eventName'] AS event, sum(value) AS n
  FROM customer_lake.metrics FINAL
  WHERE source = 'ga4' AND report = 'funnel' AND metric = 'eventCount'
    AND ts >= {from:DateTime}
  GROUP BY event`;

/** Canceled orders count as placed but stay out of revenue and the ticket. */
const ORDERS_SQL = `
  SELECT
    countIf(created_at >= {from:DateTime}) AS cur_orders,
    countIf(created_at < {from:DateTime}) AS prev_orders,
    countIf(created_at >= {from:DateTime} AND status != 'canceled') AS kept,
    countIf(created_at < {from:DateTime} AND status != 'canceled') AS prev_kept,
    sumIf(toFloat64(total), created_at >= {from:DateTime} AND status != 'canceled') AS revenue,
    sumIf(toFloat64(total), created_at < {from:DateTime} AND status != 'canceled') AS prev_revenue,
    sumIf(item_count, created_at >= {from:DateTime} AND status != 'canceled') AS item_total,
    anyIf(currency, created_at >= {from:DateTime}) AS order_currency,
    count() AS row_count,
    toString(min(created_at)) AS first
  FROM customer_lake.orders FINAL
  WHERE created_at >= {prevFrom:DateTime}`;

type Row = Record<string, unknown>;

const lakeTime = (ms: number) =>
  new Date(ms).toISOString().slice(0, 19).replace("T", " ");

const round1 = (value: number) => Math.round(value * 10) / 10;

function num(row: Row | undefined, key: string): number {
  const value = Number(row?.[key]);
  return Number.isFinite(value) ? value : 0;
}

/** `part` as a percentage of `whole`; null without a base to divide by. */
export function percent(part: number, whole: number): number | null {
  return whole > 0 ? round1((part / whole) * 100) : null;
}

/** Percent difference from `previous`; null when the previous window is not
 *  fully in the lake, so a store that just connected never reads as growing. */
export function change(
  current: number,
  previous: number,
  covered: boolean,
): number | null {
  return covered && previous > 0
    ? round1(((current - previous) / previous) * 100)
    : null;
}

/** Whether the lake's first row is early enough to cover the previous window. */
function coversPrevious(first: unknown, prevFrom: number): boolean {
  if (typeof first !== "string" || !first) return false;
  const at = Date.parse(`${first.replace(" ", "T").slice(0, 19)}Z`);
  return Number.isFinite(at) && at <= prevFrom + DAY_MS;
}

/** The snapshot from the three lake reads; null when none of them has data. */
export function buildStoreSnapshot(
  traffic: Row | undefined,
  funnel: readonly Row[],
  orders: Row | undefined,
  prevFrom: number,
): StoreSnapshot | null {
  const hasTraffic = num(traffic, "row_count") > 0;
  const hasOrders = num(orders, "row_count") > 0;
  const events = new Map(
    funnel.map((row) => [String(row.event), num(row, "n")]),
  );
  const step = (event: string) => events.get(event) ?? 0;
  const hasFunnel = step("view_item") + step("begin_checkout") > 0;
  if (!hasTraffic && !hasOrders && !hasFunnel) return null;

  const trafficCovered = coversPrevious(traffic?.first, prevFrom);
  const ordersCovered = coversPrevious(orders?.first, prevFrom);
  const kept = num(orders, "kept");
  const prevKept = num(orders, "prev_kept");
  const ticket = kept > 0 ? num(orders, "revenue") / kept : null;
  const prevTicket =
    prevKept > 0 ? num(orders, "prev_revenue") / prevKept : null;
  const currency = orders?.order_currency;
  const pageviews = num(traffic, "cur_pageviews");

  return {
    mobile_conversion_rate: hasTraffic
      ? percent(
          num(traffic, "mobile_conversions"),
          num(traffic, "mobile_visitors"),
        )
      : null,
    desktop_conversion_rate: hasTraffic
      ? percent(
          num(traffic, "desktop_conversions"),
          num(traffic, "desktop_visitors"),
        )
      : null,
    product_to_cart_rate: percent(step("add_to_cart"), step("view_item")),
    cart_to_checkout_rate: percent(step("begin_checkout"), step("add_to_cart")),
    checkout_completion_rate: percent(step("purchase"), step("begin_checkout")),
    visitors: hasTraffic ? num(traffic, "cur_visitors") : null,
    visitors_change: hasTraffic
      ? change(
          num(traffic, "cur_visitors"),
          num(traffic, "prev_visitors"),
          trafficCovered,
        )
      : null,
    orders: hasOrders ? num(orders, "cur_orders") : null,
    orders_change: hasOrders
      ? change(
          num(orders, "cur_orders"),
          num(orders, "prev_orders"),
          ordersCovered,
        )
      : null,
    revenue_change: hasOrders
      ? change(
          num(orders, "revenue"),
          num(orders, "prev_revenue"),
          ordersCovered,
        )
      : null,
    average_ticket: ticket === null ? null : Math.round(ticket * 100) / 100,
    average_ticket_change:
      ticket !== null && prevTicket !== null
        ? change(ticket, prevTicket, ordersCovered)
        : null,
    items_per_order: kept > 0 ? round1(num(orders, "item_total") / kept) : null,
    currency: typeof currency === "string" && currency ? currency : null,
    site_errors: hasTraffic ? num(traffic, "cur_errors") : null,
    site_errors_per_1k_pageviews:
      hasTraffic && pageviews > 0
        ? round1((num(traffic, "cur_errors") / pageviews) * 1000)
        : null,
  };
}

async function read(
  organizationId: string,
  sql: string,
  params: Record<string, unknown>,
): Promise<Row[]> {
  try {
    return await queryCustomerLake(organizationId, sql, params);
  } catch (error) {
    // One source failing leaves the others to decide on.
    console.warn(
      "[plan-goal] Lake read failed",
      error instanceof Error ? error.message : "unknown error",
    );
    return [];
  }
}

/** The org's snapshot at `at`; null when the lake is off or has no data. */
export async function loadStoreSnapshot(
  organizationId: string,
  at: Date,
): Promise<StoreSnapshot | null> {
  if (!isCustomerLakeConfigured()) return null;
  const from = at.getTime() - WINDOW_DAYS * DAY_MS;
  const prevFrom = from - WINDOW_DAYS * DAY_MS;
  const params = { from: lakeTime(from), prevFrom: lakeTime(prevFrom) };
  const [traffic, funnel, orders] = await Promise.all([
    read(organizationId, TRAFFIC_SQL, params),
    read(organizationId, FUNNEL_SQL, params),
    read(organizationId, ORDERS_SQL, params),
  ]);
  return buildStoreSnapshot(traffic[0], funnel, orders[0], prevFrom);
}
