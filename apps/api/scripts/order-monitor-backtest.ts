/**
 * Replays the order-monitor rules every 15 minutes over a store's past days,
 * reading the lake through the same `loadStoreDay` the sweep uses, and counts
 * the episodes that would have opened a task. Run it on every monitored store
 * before turning a rule's `NOTIFY` on; for orders_drop on the store it was
 * calibrated on, it must reproduce the original backtest (any difference is a
 * bug in the lake read, not a new calibration).
 *
 *   CUSTOMER_LAKE_URL=… CUSTOMER_LAKE_ADMIN_PASSWORD=… CUSTOMER_LAKE_TENANT_SECRET=… \
 *     bun apps/api/scripts/order-monitor-backtest.ts <organizationId> <connectionId> [days=28]
 */

import {
  loadStoreDay,
  loadStoreTimezone,
  localDayStart,
} from "../src/monitoring/order-lake";
import { bucketTime } from "../src/monitoring/order-incidents";
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
const totals = Object.fromEntries(
  RULES.map((r) => [r, { warning: 0, alert: 0 }]),
);

for (let n = Number(daysArg); n >= 1; n--) {
  // The day's last instant, so every bucket of it is in.
  const at = new Date(todayStart - (n - 1) * DAY_MS - 1);
  const day = await loadStoreDay(organizationId, connectionId, at);
  if (!day) continue;
  const fired: string[] = [];
  const prev = Object.fromEntries(RULES.map((r) => [r, "ok"]));
  for (let done = 4; done <= 96; done++) {
    const verdicts = evaluateStore({ ...day, done });
    if (!verdicts) continue;
    for (const rule of RULES) {
      const v = verdicts[rule];
      const s = v.status === "low-volume" ? "ok" : v.status;
      // Episodes, not ticks: a dip that stays low for 3 checks is one task.
      if (s !== "ok" && s !== prev[rule]) {
        totals[rule]![s]++;
        fired.push(
          `${rule} ${s} at ${bucketTime(done)}: ${v.observed} vs ${v.expected.toFixed(0)} usual`,
        );
      }
      prev[rule] = s;
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
