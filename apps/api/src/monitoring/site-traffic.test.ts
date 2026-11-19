import { describe, expect, it, mock } from "bun:test";
import type { SiteTrafficDay } from "@decocms/shared/order-monitor";

let hourly: Record<string, unknown>[] = [];
let headline: Record<string, unknown>[] = [];

mock.module("../customer-lake/client", () => ({
  queryCustomerLake: async (_org: string, sql: string) =>
    sql.includes("AS h,") ? hourly : headline,
}));

const { addSiteTraffic, loadSiteTraffic } = await import("./site-traffic");

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

const flat = (n: number) => new Array<number>(24).fill(n);
const upTo = (n: number, hour: number) =>
  flat(n).map((v, h) => (h <= hour ? v : null));

function day(n: number, hour: number): SiteTrafficDay {
  const series = {
    today: upTo(n, hour),
    d1: flat(n),
    w1: flat(n),
    y1: flat(n),
  };
  const head = { today: n, d1: 2 * n, w1: 3 * n, y1: 4 * n };
  return {
    visitors: series,
    pageviews: series,
    conversions: series,
    headline: { visitors: head, pageviews: head, conversions: head },
  };
}

describe("addSiteTraffic", () => {
  it("adds several orgs' sites up, hour by hour and in the headline", () => {
    const sum = addSiteTraffic([day(10, 11), null, day(5, 13)])!;
    expect(sum.visitors.today[11]).toBe(15);
    // An hour only one org has reached counts that org alone.
    expect(sum.visitors.today[13]).toBe(5);
    expect(sum.visitors.today[14]).toBeNull();
    expect(sum.pageviews.w1[20]).toBe(15);
    expect(sum.headline.conversions).toEqual({
      today: 15,
      d1: 30,
      w1: 45,
      y1: 60,
    });
  });

  it("has nothing when no org has traffic", () => {
    expect(addSiteTraffic([null, null])).toBeNull();
    expect(addSiteTraffic([])).toBeNull();
  });
});
