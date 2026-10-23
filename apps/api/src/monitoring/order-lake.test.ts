import { describe, expect, it, mock } from "bun:test";

const rowsBySql = new Map<string, Record<string, unknown>[]>();

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
      return rowsBySql.get("channels") ?? [];
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
