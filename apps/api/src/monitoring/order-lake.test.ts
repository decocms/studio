import { describe, expect, it, mock } from "bun:test";

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
    }
    return [];
  },
}));

const { loadStoreDay } = await import("./order-lake");

describe("loadChannels", () => {
  it("falls back to null, not the string 'null', for a channel with no name", async () => {
    rowsBySql.set("channels", [
      { channel: "1", days_ago: "0", bucket: "0", placed: "3" },
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
