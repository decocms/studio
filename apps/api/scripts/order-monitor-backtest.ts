/**
 * Replays the order-monitor rules every 15 minutes over a store's past days,
 * reading the lake through the same `loadStoreDay` the sweep uses, and lists
 * the alerts the sweep would have opened: each crossing into `alert`. Run it
 * on a store before changing a rule's thresholds.
 *
 *   CUSTOMER_LAKE_URL=… CUSTOMER_LAKE_ADMIN_PASSWORD=… CUSTOMER_LAKE_TENANT_SECRET=… \
 *     bun apps/api/scripts/order-monitor-backtest.ts <organizationId> <connectionId> [days=28]
 */

import {
  loadStoreDay,
  loadStoreTimezone,
  localDayStart,
} from "../src/monitoring/order-lake";
import { bucketTime } from "../src/monitoring/order-alerts";
import { evaluateStore, RULES } from "../src/monitoring/order-rules";

const [organizationId, connectionId, daysArg = "28"] = process.argv.slice(2);
if (!organizationId || !connectionId) {
  console.error(
    "usage: order-monitor-backtest.ts <organizationId> <connectionId> [days]",
  );
  process.exit(1);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const timezone = await loadStoreTimezone(organizationId, connectionId);
if (!timezone) {
  console.error("the lake has no timezone for this store");
  process.exit(1);
}

const todayStart = localDayStart(new Date(), timezone).getTime();
const totals = Object.fromEntries(RULES.map((r) => [r, 0]));

for (let n = Number(daysArg); n >= 1; n--) {
  // The day's last instant, so every bucket of it is in.
  const at = new Date(todayStart - (n - 1) * DAY_MS - 1);
  const day = await loadStoreDay(organizationId, connectionId, at);
  if (!day) continue;
  const fired: string[] = [];
  const last = Object.fromEntries(RULES.map((r) => [r, "ok"]));
  for (let done = 0; done <= 96; done++) {
    const verdicts = evaluateStore({ ...day, done });
    for (const rule of RULES) {
      const v = verdicts[rule];
      if (v.status === "alert" && last[rule] !== "alert") {
        totals[rule]!++;
        fired.push(
          `${rule} at ${bucketTime(done)}: ${v.observed} vs ${v.expected.toFixed(0)} usual`,
        );
      }
      last[rule] = v.status;
    }
  }
  const date = at.toLocaleDateString("en-CA", { timeZone: timezone });
  const placed = day.days[0].placed.reduce((a, b) => a + b, 0);
  console.log(
    date,
    String(placed).padStart(5),
    "orders ",
    fired.join(" | ") || "—",
  );
}
console.log(totals);
