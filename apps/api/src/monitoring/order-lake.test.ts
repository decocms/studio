import { afterEach, describe, expect, it, mock } from "bun:test";
import { BUCKETS_PER_DAY, DAYS_AGO } from "./order-rules";

const rowsBySql = new Map<string, Record<string, unknown>[]>();
const failSql = new Set<string>();

mock.module("../customer-lake/client", () => ({
  queryCustomerLake: async (
    _organizationId: string,
    sql: string,
  ): Promise<Record<string, unknown>[]> => {
    if (sql.includes("FROM customer_lake.connections")) {
      return [{ timezone: "UTC" }];
    }
    if (sql.includes("FROM customer_lake.sales_channels")) {
      return rowsBySql.get("names") ?? [];
    }
    if (sql.includes("minOrNull(changed_at)")) {
      return [{ days_ago: null }];
    }
    if (sql.includes("sales_channel AS channel")) {
      if (failSql.has("channels")) throw new Error("boom");
      return rowsBySql.get("channels") ?? [];
    }
    if (sql.includes("updated_at") && sql.includes("canceled")) {
      if (failSql.has("approximate")) throw new Error("boom");
      return [];
    }
    if (sql.includes("toHour(created_at, {tz:String}) AS bucket"))
      return rowsBySql.get("hourly") ?? [];
    if (sql.includes("sum(total)")) return rowsBySql.get("orders") ?? [];
    if (sql.includes("uniqExactIf")) return rowsBySql.get("events") ?? [];
    return [];
  },
}));

const { HISTORY_DAYS, loadHourlyHistory, loadStoreDay } = await import(
  "./order-lake"
);

afterEach(() => rowsBySql.clear());

// The lake's shape for a per-bucket query: one row per day, buckets in
// arbitrary order, UInt64 counts as strings.
function dayRow(daysAgo: number, buckets: number[]) {
  return {
    days_ago: String(daysAgo),
    bucket: buckets,
    placed: buckets.map((b) => String(daysAgo * 1000 + b)),
    revenue: buckets.map((b) => b + 0.5),
    items: buckets.map(() => "2"),
    currency: buckets.map(() => "BRL"),
  };
}

const allBuckets = () =>
  Array.from({ length: BUCKETS_PER_DAY }, (_, b) => b).reverse();

describe("loadChannels", () => {
  it("falls back to null, not the string 'null', for a channel with no name", async () => {
    rowsBySql.set("channels", [
      { channel: "1", days_ago: "0", bucket: [0], placed: ["3"] },
    ]);
    rowsBySql.set("names", [{ channel_id: "1", name: null }]);

    const day = await loadStoreDay("org", "conn", new Date(), {
      channels: true,
    });

    expect(day?.channels).toEqual([
      { id: "1", name: null, today: expect.any(Array), d1: expect.any(Array) },
    ]);
  });
});

describe("loadStoreDay", () => {
  it("keeps every bucket when the days hold more than the lake's 1000-row cap", async () => {
    rowsBySql.set(
      "orders",
      DAYS_AGO.map((d) => dayRow(d, allBuckets())),
    );
    expect(DAYS_AGO.length * BUCKETS_PER_DAY).toBeGreaterThan(1000);

    const day = await loadStoreDay("org", "conn", new Date());

    for (const d of DAYS_AGO) {
      expect(day?.days[d].placed).toEqual(
        Array.from({ length: BUCKETS_PER_DAY }, (_, b) => d * 1000 + b),
      );
    }
    expect(day?.currency).toBe("BRL");
  });

  it("spreads each day's buckets to their slots and leaves days without rows at zero", async () => {
    rowsBySql.set("orders", [
      dayRow(0, [5, 2]),
      dayRow(1, allBuckets()),
      { ...dayRow(2, []), currency: [] },
    ]);
    rowsBySql.set("events", [
      {
        days_ago: "0",
        bucket: [2, 40],
        canceled: ["1", "0"],
        denied: ["0", "3"],
      },
    ]);

    const day = await loadStoreDay("org", "conn", new Date());

    const d0 = day?.days[0];
    expect(d0?.placed[2]).toBe(2);
    expect(d0?.placed[5]).toBe(5);
    expect(d0?.revenue[5]).toBe(5.5);
    expect(d0?.items[5]).toBe(2);
    expect(d0?.placed.reduce((a, b) => a + b, 0)).toBe(7);
    expect(d0?.canceled[2]).toBe(1);
    expect(d0?.denied[40]).toBe(3);
    expect(day?.days[1].placed.every((n, b) => n === 1000 + b)).toBe(true);
    expect(day?.days[2].placed.every((n) => n === 0)).toBe(true);
    expect(day?.days[7].placed.every((n) => n === 0)).toBe(true);
  });

  it("splits channels by day from one row per channel and day", async () => {
    rowsBySql.set("channels", [
      { channel: "1", days_ago: "0", bucket: [3, 1], placed: ["4", "2"] },
      { channel: "1", days_ago: "1", bucket: [3], placed: ["7"] },
      { channel: "2", days_ago: "0", bucket: [0], placed: ["9"] },
    ]);

    const day = await loadStoreDay("org", "conn", new Date(), {
      channels: true,
    });

    const one = day?.channels?.find((c) => c.id === "1");
    expect(one?.today[1]).toBe(2);
    expect(one?.today[3]).toBe(4);
    expect(one?.d1[3]).toBe(7);
    expect(day?.channels?.find((c) => c.id === "2")?.today[0]).toBe(9);
  });

  it("still returns the real orders/events data when the channels read fails", async () => {
    failSql.add("channels");
    const day = await loadStoreDay("org", "conn", new Date(), {
      channels: true,
    });
    failSql.delete("channels");

    expect(day?.channels).toBeUndefined();
    expect(day?.timezone).toBe("UTC");
  });

  it("still returns the real orders/events data when the approximate-cancels read fails", async () => {
    failSql.add("approximate");
    const day = await loadStoreDay("org", "conn", new Date(), {
      approximate: true,
    });
    failSql.delete("approximate");

    expect(day?.approximate?.[0]?.canceled.every((n) => n === 0)).toBe(true);
    expect(day?.timezone).toBe("UTC");
  });
});

describe("loadHourlyHistory", () => {
  it("keeps every hour of every day past the lake's 1000-row cap, zero where no row", async () => {
    const hoursOf = (d: number) =>
      Array.from({ length: 24 }, (_, h) => h).filter((h) => d % 2 || h % 3);
    rowsBySql.set(
      "hourly",
      Array.from({ length: HISTORY_DAYS + 1 }, (_, d) => ({
        days_ago: String(d),
        bucket: hoursOf(d),
        placed: hoursOf(d).map((h) => String(d * 100 + h)),
        revenue: hoursOf(d).map((h) => h + 0.5),
      })),
    );
    expect((HISTORY_DAYS + 1) * 24).toBeGreaterThan(1000);

    const days = await loadHourlyHistory("org", "conn", new Date(), "UTC");

    expect(days).toHaveLength(HISTORY_DAYS + 1);
    expect(days[HISTORY_DAYS]!.orders[23]).toBe(HISTORY_DAYS * 100 + 23);
    expect(days[5]!.orders[3]).toBe(503);
    expect(days[5]!.revenue[3]).toBe(3.5);
    // An even day has no row for hours divisible by 3.
    expect(days[4]!.orders[3]).toBe(0);
    expect(days[4]!.orders[4]).toBe(404);
  });

  it("ignores a day or hour outside the window", async () => {
    rowsBySql.set("hourly", [
      {
        days_ago: String(HISTORY_DAYS + 1),
        bucket: [1],
        placed: ["9"],
        revenue: [9],
      },
      { days_ago: "0", bucket: [24], placed: ["9"], revenue: [9] },
    ]);

    const days = await loadHourlyHistory("org", "conn", new Date(), "UTC");

    expect(days.every((d) => d.orders.every((n) => n === 0))).toBe(true);
  });
});
