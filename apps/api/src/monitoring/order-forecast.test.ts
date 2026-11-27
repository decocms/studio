import { afterAll, describe, expect, it, spyOn } from "bun:test";
import type { OrderMonitorForecast } from "@decocms/shared/order-monitor";
import {
  buildRequest,
  CONTEXT_DAYS,
  cleanHistory,
  forecastCacheKey,
  type ModelForecast,
  modelProjection,
  requestForecast,
  runModel,
  type TimestralService,
  toProjection,
} from "./order-forecast";
import { HISTORY_DAYS, type HourlyDay } from "./order-lake";
import {
  BUCKETS_PER_DAY,
  DAYS_AGO,
  type DayAgo,
  type DaySeries,
  type StoreDay,
} from "./order-rules";

const hours = (n: number) => new Array<number>(24).fill(n);
const hourly = (orders: number, revenue = orders * 100): HourlyDay => ({
  orders: hours(orders),
  revenue: hours(revenue),
});
/** HISTORY_DAYS + 1 days, index = days ago; `pick` overrides some. */
const history = (
  pick: (d: number) => HourlyDay | undefined = () => undefined,
) => Array.from({ length: HISTORY_DAYS + 1 }, (_, d) => pick(d) ?? hourly(10));

const flat = (n: number) => new Array<number>(BUCKETS_PER_DAY).fill(n);
function storeDay(done: number): StoreDay {
  const series = (): DaySeries => ({
    placed: flat(1),
    revenue: flat(100),
    items: flat(2),
    canceled: flat(0),
    denied: flat(0),
  });
  const days = Object.fromEntries(DAYS_AGO.map((d) => [d, series()])) as Record<
    DayAgo,
    DaySeries
  >;
  return { timezone: "UTC", done, days, firstEventDaysAgo: 60 };
}

const baseline: OrderMonitorForecast = {
  orders: hours(1),
  revenue: hours(100),
  close: { orders: 1, revenue: 100 },
  initial: { orders: 240, revenue: 24_000 },
  paths: [{ daysAgo: 7, orders: hours(1), revenue: hours(1) }],
};

describe("cleanHistory", () => {
  it("drops an outage day as missing, never as zero", () => {
    // Day 5 brought 2 orders an hour against 10: under 25% of the median.
    const out = cleanHistory(history((d) => (d === 5 ? hourly(2) : undefined)));
    expect(out[5]).toBeNull();
    expect(out[4]).toEqual(hourly(10));
    expect(out[6]).toEqual(hourly(10));
  });

  it("keeps a slow day above the outage share", () => {
    const out = cleanHistory(history((d) => (d === 5 ? hourly(3) : undefined)));
    expect(out[5]).toEqual(hourly(3));
  });

  it("drops days without orders and days still backfilling, but keeps today", () => {
    const out = cleanHistory(
      history((d) => (d === 0 || d === 9 ? hourly(0) : undefined)),
      [3],
    );
    expect(out[9]).toBeNull();
    expect(out[3]).toBeNull();
    expect(out[0]).toEqual(hourly(0));
  });

  it("judges each day against the kept days before it, so an outage doesn't lower the bar", () => {
    // Two outage days in a row: the second is judged against the 10s, not the first.
    const out = cleanHistory(
      history((d) => (d === 6 || d === 5 ? hourly(1) : undefined)),
    );
    expect(out[6]).toBeNull();
    expect(out[5]).toBeNull();
  });
});

describe("buildRequest", () => {
  // Day d's hour h holds d * 100 + h, so a value tells where it came from.
  const tagged = (): (HourlyDay | null)[] =>
    history((d) => ({
      orders: HOURS.map((h) => d * 100 + h + 1),
      revenue: HOURS.map((h) => -(d * 100 + h + 1)),
    }));
  const HOURS = Array.from({ length: 24 }, (_, h) => h);

  it("ends today's series at the hour under way and forecasts the rest of the day", () => {
    const { series, horizon } = buildRequest(tagged(), 10);
    expect(horizon).toBe(14);
    const [orders, revenue] = series;
    expect(orders).toHaveLength(CONTEXT_DAYS * 24);
    // Last value: today's hour 9; first: hour 10 of the day CONTEXT_DAYS back.
    expect(orders!.at(-1)).toBe(10);
    expect(orders![0]).toBe(CONTEXT_DAYS * 100 + 11);
    expect(revenue!.at(-1)).toBe(-10);
  });

  it("gives each of the last 28 days the full context, ending at its own hour", () => {
    const { series, calibration } = buildRequest(tagged(), 10);
    expect(calibration.map((c) => c.daysAgo)).toEqual(
      Array.from({ length: 28 }, (_, i) => i + 1),
    );
    expect(series).toHaveLength(2 + 2 * 28);
    for (const s of series) {
      expect(s).toHaveLength(CONTEXT_DAYS * 24);
      expect(s.includes(null)).toBe(false);
    }
    // Day 28's series: hour 10 of day 28 + CONTEXT_DAYS up to its hour 9.
    const day28 = series.at(-2)!;
    expect(day28[0]).toBe((28 + CONTEXT_DAYS) * 100 + 11);
    expect(day28.at(-1)).toBe(28 * 100 + 10);
  });

  it("left-pads a calibration day past a dropped one, whose context runs out of history", () => {
    const days = tagged();
    days[2] = null;
    const { series, calibration } = buildRequest(days, 10);
    expect(calibration.map((c) => c.daysAgo)).toEqual([
      1,
      ...Array.from({ length: 27 }, (_, i) => i + 3),
    ]);
    expect(new Set(series.map((s) => s.length))).toEqual(
      new Set([CONTEXT_DAYS * 24]),
    );
    // Day 29 would need hours of day 141, which the history doesn't hold.
    const day29 = series.at(-2)!;
    expect(day29.slice(0, 14)).toEqual(new Array(14).fill(null));
    expect(day29[14]).toBe(HISTORY_DAYS * 100 + 1);
    expect(day29.at(-1)).toBe(29 * 100 + 10);
    const day1 = series[2]!;
    expect(day1.at(-1)).toBe(100 + 10);
    // Its rest of day: hours 10..23.
    expect(calibration[0]!.actual.orders).toBe(
      HOURS.slice(10).reduce((s, h) => s + 100 + h + 1, 0),
    );
  });

  it("sends a missing day as nulls", () => {
    const days = tagged();
    days[30] = null;
    const [orders] = buildRequest(days, 0).series;
    const start = (CONTEXT_DAYS - 30) * 24;
    expect(orders!.slice(start, start + 24)).toEqual(new Array(24).fill(null));
    expect(orders![start + 24]).toBe(29 * 100 + 1);
  });
});

describe("toProjection", () => {
  // At 10:30: buckets 40 and 41 of hour 10 are in, 1 order and 100 each.
  const day = storeDay(42);
  const model: ModelForecast = {
    hour: 10,
    orders: hours(5).slice(10),
    revenue: hours(500).slice(10),
    ratios: [
      { daysAgo: 1, orders: 1.2, revenue: 0.5 },
      { daysAgo: 3, orders: 0.8, revenue: 1 },
    ],
  };

  it("leaves hours gone at 0 and takes what's in from the hour under way", () => {
    const p = toProjection(baseline, day, model);
    expect(p.orders.slice(0, 10)).toEqual(new Array(10).fill(0));
    expect(p.orders[10]).toBe(3);
    expect(p.orders[11]).toBe(5);
    expect(p.revenue[10]).toBe(300);
    expect(p.close.orders).toBe(42 + 3 + 13 * 5);
    expect(p.close.revenue).toBe(4200 + 300 + 13 * 500);
    expect(p.initial).toBe(baseline.initial);
  });

  it("floors the hour under way at 0 when more is already in than forecast", () => {
    const p = toProjection(baseline, storeDay(42), {
      ...model,
      orders: [1, ...hours(5).slice(11)],
    });
    expect(p.orders[10]).toBe(0);
  });

  it("scales the running median by each calibration day's ratio", () => {
    const p = toProjection(baseline, day, model);
    expect(p.paths.map((x) => x.daysAgo)).toEqual([1, 3]);
    const [d1, d3] = p.paths;
    expect(d1!.orders[9]).toBe(0);
    expect(d1!.orders[10]).toBeCloseTo(3 * 1.2);
    expect(d1!.orders[23]).toBeCloseTo((3 + 13 * 5) * 1.2);
    expect(d3!.orders[23]).toBeCloseTo((3 + 13 * 5) * 0.8);
    expect(d1!.revenue[23]).toBeCloseTo((300 + 13 * 500) * 0.5);
  });
});

// A real forecasting service stand-in: answers each series' horizon with
// `value`, or fails the way `mode` says.
let mode: "ok" | "500" | "malformed" | "short" | "slow" = "ok";
let value = 2;
let hits = 0;
let lastAuth: string | null = null;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    hits++;
    lastAuth = req.headers.get("authorization");
    const body = (await req.json()) as {
      series: unknown[][];
      horizon: number;
      quantiles: number[];
    };
    if (mode === "500") return new Response("boom", { status: 500 });
    if (mode === "malformed") return Response.json({ median: [] });
    if (mode === "slow") await Bun.sleep(500);
    const horizon = mode === "short" ? body.horizon - 1 : body.horizon;
    return Response.json({
      quantiles: {
        "0.5": body.series.map(() => new Array(horizon).fill(value)),
      },
    });
  },
});
afterAll(() => server.stop(true));
const service = { url: server.url.href, token: "t0ken", timeoutMs: 200 };
/** Its own URL on the same server, so a cooldown stays within one test. */
const serviceAt = (path: string, cooldownMs?: number) => ({
  ...service,
  url: `${server.url.href}${path}`,
  cooldownMs,
});

describe("requestForecast", () => {
  it("sends the bearer token and returns the median per series", async () => {
    mode = "ok";
    value = 2;
    const out = await requestForecast(service, [[1, null, 3]], 4);
    expect(out).toEqual([[2, 2, 2, 2]]);
    expect(lastAuth).toBe("Bearer t0ken");
  });

  for (const failing of ["500", "malformed", "short", "slow"] as const) {
    it(`throws on a ${failing} answer`, async () => {
      mode = failing;
      await expect(requestForecast(service, [[1]], 4)).rejects.toThrow();
    });
  }
});

describe("runModel", () => {
  it("rates each calibration day's actual rest against its forecast", async () => {
    mode = "ok";
    value = 4;
    // At hour 12 each past day has 12 hours left: 120 orders, 12,000 revenue,
    // against a forecast of 12 × 4 = 48.
    const model = await runModel(service, cleanHistory(history()), 12);
    expect(model.orders).toEqual(hours(4).slice(12));
    expect(model.ratios).toHaveLength(28);
    expect(model.ratios[0]).toEqual({
      daysAgo: 1,
      orders: 120 / 48,
      revenue: 12_000 / 48,
    });
  });

  it("skips calibration days the model forecast nothing for", async () => {
    mode = "ok";
    value = -1;
    const model = await runModel(service, cleanHistory(history()), 12);
    expect(model.ratios).toEqual([]);
  });
});

describe("modelProjection", () => {
  const at = new Date("2026-11-26T10:30:00Z");
  const on = { monitor_timestral_projection: true };
  const args = (
    connectionId: string,
    flags: Record<string, unknown>,
    service: TimestralService = serviceAt(connectionId),
  ) => ({
    organizationId: "org",
    connectionId,
    at,
    day: storeDay(42),
    baseline,
    flags,
    service,
    loadHistory: async () => history(),
  });

  it("returns the baseline untouched with the flag off, without calling the model", async () => {
    mode = "ok";
    const before = hits;
    expect(await modelProjection(args("off", {}))).toBe(baseline);
    expect(
      await modelProjection(
        args("off", { monitor_timestral_projection: false }),
      ),
    ).toBe(baseline);
    expect(hits).toBe(before);
  });

  it("falls back to the baseline when the model fails", async () => {
    for (const failing of ["500", "malformed", "slow"] as const) {
      mode = failing;
      const p = await modelProjection(args(`fails-${failing}`, on));
      expect(p).toBe(baseline);
    }
  });

  it("falls back to the baseline when the lake read fails", async () => {
    mode = "ok";
    const p = await modelProjection({
      ...args("lake-down", on),
      loadHistory: () => Promise.reject(new Error("lake down")),
    });
    expect(p).toBe(baseline);
  });

  it("forecasts once per store hour, and again after a failure", async () => {
    // No cooldown, so the retry reaches the service.
    const svc = serviceAt("cached", 0);
    mode = "500";
    await modelProjection(args("cached", on, svc));
    mode = "ok";
    value = 3;
    const before = hits;
    const first = await modelProjection(args("cached", on, svc));
    expect(first).not.toBe(baseline);
    expect(first.orders[11]).toBe(3);
    value = 9;
    const again = await modelProjection(args("cached", on, svc));
    expect(again.orders[11]).toBe(3);
    expect(hits).toBe(before + 1);
    // Another store is its own forecast.
    const other = await modelProjection(args("cached-other", on, svc));
    expect(other.orders[11]).toBe(9);
    expect(hits).toBe(before + 2);
  });
});

describe("modelProjection's cooldown", () => {
  const at = new Date("2026-11-26T10:30:00Z");
  const on = { monitor_timestral_projection: true };
  let loads = 0;
  const args = (connectionId: string, service: TimestralService) => ({
    organizationId: "org",
    connectionId,
    at,
    day: storeDay(42),
    baseline,
    flags: on,
    service,
    loadHistory: async () => {
      loads++;
      return history();
    },
  });
  const serviceWarnings = (warn: { mock: { calls: unknown[][] } }) =>
    warn.mock.calls.filter((c) =>
      String(c[0]).includes("forecast service failed"),
    ).length;

  it("skips a failed service for the cooldown, logging once, then calls it again", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const down = serviceAt("cooldown", 300);
      mode = "500";
      expect(await modelProjection(args("a", down))).toBe(baseline);
      mode = "ok";
      value = 3;
      const [hitsBefore, loadsBefore] = [hits, loads];
      // Another store, same service: today's projection without the lake or the model.
      expect(await modelProjection(args("b", down))).toBe(baseline);
      expect(await modelProjection(args("c", down))).toBe(baseline);
      expect([hits, loads]).toEqual([hitsBefore, loadsBefore]);
      expect(serviceWarnings(warn)).toBe(1);
      // Another service URL isn't cooling down.
      const other = await modelProjection(args("b", serviceAt("elsewhere")));
      expect(other.orders[11]).toBe(3);
      await Bun.sleep(350);
      const back = await modelProjection(args("c", down));
      expect(back.orders[11]).toBe(3);
      expect(serviceWarnings(warn)).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("logs once for failures that were in flight together", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      mode = "slow";
      const down = serviceAt("burst", 60_000);
      const before = hits;
      const out = await Promise.all(
        ["1", "2", "3", "4", "5"].map((id) => modelProjection(args(id, down))),
      );
      expect(out.every((p) => p === baseline)).toBe(true);
      expect(hits).toBe(before + 5);
      expect(serviceWarnings(warn)).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("doesn't cool the service down over a failed lake read", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      mode = "ok";
      value = 5;
      const svc = serviceAt("lake-only", 60_000);
      const p = await modelProjection({
        ...args("x", svc),
        loadHistory: () => Promise.reject(new Error("lake down")),
      });
      expect(p).toBe(baseline);
      expect(serviceWarnings(warn)).toBe(0);
      expect((await modelProjection(args("y", svc))).orders[11]).toBe(5);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("forecastCacheKey", () => {
  it("keeps orgs, stores, dates and hours apart", () => {
    const keys = [
      forecastCacheKey("org-a", "conn", "2026-11-26", 10),
      forecastCacheKey("org-b", "conn", "2026-11-26", 10),
      forecastCacheKey("org-a", "conn-2", "2026-11-26", 10),
      forecastCacheKey("org-a", "conn", "2026-11-25", 10),
      forecastCacheKey("org-a", "conn", "2026-11-26", 11),
      // A separator inside an id must not collide with the next field.
      forecastCacheKey("org-a:conn", "", "2026-11-26", 10),
      forecastCacheKey("org-a", ":conn", "2026-11-26", 10),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});
