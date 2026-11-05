import { expect, it, mock } from "bun:test";

let hourly: Record<string, unknown>[] = [];
let headline: Record<string, unknown>[] = [];

mock.module("../customer-lake/client", () => ({
  queryCustomerLake: async (_org: string, sql: string) =>
    sql.includes("AS h,") ? hourly : headline,
}));

const { loadSiteTraffic } = await import("./site-traffic");

// 14:30 in São Paulo.
const AT = new Date("2026-10-28T17:30:00Z");

it("is null before any linked site has synced", async () => {
  hourly = [];
  headline = [];
  expect(await loadSiteTraffic("org", AT, "America/Sao_Paulo", "")).toBeNull();
});

it("leaves today's hours after now empty and takes the headline from the day's uniques", async () => {
  // UInt64 arrives as a string in JSONEachRow.
  hourly = [
    { days_ago: "0", h: "0", visitors: "10", conversions: "1" },
    { days_ago: "0", h: "14", visitors: "12", conversions: "0" },
    { days_ago: "7", h: "20", visitors: "30", conversions: "2" },
  ];
  headline = [
    { days_ago: "0", visitors: "18", conversions: "1" },
    { days_ago: "7", visitors: "5", conversions: "0" },
  ];
  const day = await loadSiteTraffic("org", AT, "America/Sao_Paulo", "");
  expect(day?.visitors.today[0]).toBe(10);
  expect(day?.visitors.today[14]).toBe(12);
  expect(day?.visitors.today[15]).toBeNull();
  expect(day?.visitors.w1[20]).toBe(30);
  expect(day?.visitors.d1).toEqual(new Array(24).fill(0));
  // 18, not 10 + 12: one visitor across two hours is still one.
  expect(day?.headline.visitors).toEqual({ today: 18, d1: 0, w1: 5, y1: 0 });
  expect(day?.conversions.today[0]).toBe(1);
  expect(day?.conversions.w1[20]).toBe(2);
  expect(day?.headline.conversions).toEqual({ today: 1, d1: 0, w1: 0, y1: 0 });
});
