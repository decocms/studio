/**
 * What an order-monitor alert says: a title naming the store, the rule and
 * since when, and the numbers behind it. The sweep opens one when a rule
 * crosses into `alert` (`dbos-order-monitor.ts`).
 */

import { ORDER_MONITOR_ALERT_SOURCE } from "@decocms/shared/alerts";
import {
  ORDER_MONITOR_DEFAULT_THRESHOLDS,
  ORDER_MONITOR_RULES,
  orderMonitorChartPath,
  type OrderMonitorThresholds,
  type OrderMonitorVerdict,
} from "@decocms/shared/order-monitor";
import type { AlertStorage } from "@/storage/alerts";
import { localBucketStart } from "./order-lake";
import { BUCKETS_PER_DAY, type Rule } from "./order-rules";

/** The org's thresholds, its defaults for every rule it never set. */
export async function loadThresholds(
  alerts: AlertStorage,
  organizationId: string,
): Promise<OrderMonitorThresholds> {
  const own = new Map(
    (
      await alerts.listRuleSettings(organizationId, ORDER_MONITOR_ALERT_SOURCE)
    ).map((s) => [s.rule, s]),
  );
  return Object.fromEntries(
    ORDER_MONITOR_RULES.map((rule) => {
      const set = own.get(rule);
      return [
        rule,
        set
          ? { threshold: set.threshold, minVolume: set.minVolume }
          : ORDER_MONITOR_DEFAULT_THRESHOLDS[rule],
      ];
    }),
  ) as OrderMonitorThresholds;
}

const RULE_NOUN: Record<Rule, string> = {
  orders_drop: "Orders",
  denied_spike: "Unpaid cancellations",
  cancel_spike: "Cancellations",
};

const pad = (n: number) => String(n).padStart(2, "0");
/** HH:MM of a 15-minute bucket of the local day. */
export const bucketTime = (bucket: number) => {
  const b = (bucket + BUCKETS_PER_DAY) % BUCKETS_PER_DAY;
  return `${pad(Math.floor((b * 15) / 60))}:${pad((b * 15) % 60)}`;
};
const round = (n: number) => Math.round(n).toLocaleString("en-US");

export function alertTitle(
  rule: Rule,
  store: string,
  v: OrderMonitorVerdict,
): string {
  const since = bucketTime(v.from);
  if (rule === "orders_drop") {
    const below =
      v.expected > 0 ? Math.round((1 - v.observed / v.expected) * 100) : 100;
    return `Orders at ${store} are ${below} % below expected since ${since}`;
  }
  return `${RULE_NOUN[rule]} at ${store}: ${round(v.observed)} in an hour vs ${round(v.expected)} expected, since ${since}`;
}

export function alertBody(rule: Rule, v: OrderMonitorVerdict): string {
  return `${RULE_NOUN[rule]}: ${round(v.observed)} between ${bucketTime(v.from)} and ${bucketTime(v.to)} vs ${round(v.expected)} expected.`;
}

/** The store's Orders chart at the start of the verdict's window. */
export function alertLink(
  orgSlug: string,
  connectionId: string,
  at: Date,
  v: OrderMonitorVerdict,
): string {
  const start = localBucketStart(at, v.timezone, v.from);
  return orderMonitorChartPath(orgSlug, connectionId, start.toISOString());
}
