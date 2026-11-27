import { afterAll, describe, expect, it, spyOn } from "bun:test";
import type { OrderMonitorForecast } from "@decocms/shared/order-monitor";
import {
  BACKFILL_DAYS_PER_RUN,
  buildRequest,
  CONTEXT_DAYS,
  calibrationDays,
  cleanHistory,
  type ForecastJob,
  forecastJobs,
  forecastStore,
  forecastWorkflowId,
  localDateBefore,
  requestForecast,
  runModel,
  toProjection,
  withModel,
} from "./order-forecast";
import { HISTORY_DAYS, type HourlyDay } from "./order-lake";
import {
  BUCKETS_PER_DAY,
  buildDayView,
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
const HOURS_FROM = (from: number) =>
  Array.from({ length: 24 - from }, (_, i) => from + i);
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

  const calibrated = (days: (HourlyDay | null)[], hour: number) => {
    const calibration = calibrationDays(days, hour);
    const { series } = buildRequest(days, hour, [
      0,
      ...calibration.map((c) => c.daysAgo),
    ]);
    return { series, calibration };
  };

  it("ends today's series at the hour under way and forecasts the rest of the day", () => {
    const { series, horizon } = buildRequest(tagged(), 10, [0]);
    expect(horizon).toBe(14);
    const [orders, revenue] = series;
    expect(orders).toHaveLength(CONTEXT_DAYS * 24);
    // Last value: today's hour 9; first: hour 10 of the day CONTEXT_DAYS back.
    expect(orders!.at(-1)).toBe(10);
    expect(orders![0]).toBe(CONTEXT_DAYS * 100 + 11);
    expect(revenue!.at(-1)).toBe(-10);
  });

  it("gives each of the last 28 days the full context, ending at its own hour", () => {
    const { series, calibration } = calibrated(tagged(), 10);
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
    const { series, calibration } = calibrated(days, 10);
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

  it("calibrates on kept days no more than 35 days back", () => {
    const days = tagged();
    for (let d = 1; d <= 30; d++) days[d] = null;
    expect(calibrationDays(days, 10).map((c) => c.daysAgo)).toEqual([
      31, 32, 33, 34, 35,
    ]);
  });

  it("sends only the days asked for, in order", () => {
    const { series } = buildRequest(tagged(), 10, [0, 5]);
    expect(series).toHaveLength(4);
    expect(series[2]!.at(-1)).toBe(5 * 100 + 10);
    expect(series[3]!.at(-1)).toBe(-(5 * 100 + 10));
  });

  it("sends a missing day as nulls", () => {
    const days = tagged();
    days[30] = null;
    const [orders] = buildRequest(days, 0, [0]).series;
    const start = (CONTEXT_DAYS - 30) * 24;
    expect(orders!.slice(start, start + 24)).toEqual(new Array(24).fill(null));
    expect(orders![start + 24]).toBe(29 * 100 + 1);
  });
});

describe("toProjection", () => {
  // At 10:30: buckets 40 and 41 of hour 10 are in, 1 order and 100 each.
  const day = storeDay(42);
  const model: Parameters<typeof toProjection>[2] = {
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

  it("reads a forecast from the hour before from the hour under way on", () => {
    // From hour 9: index 0 is hour 9, gone; hour 10 is index 1.
    const p = toProjection(baseline, day, {
      ...model,
      hour: 9,
      orders: [100, ...HOURS_FROM(10).map((h) => h)],
    });
    expect(p.orders.slice(0, 10)).toEqual(new Array(10).fill(0));
    expect(p.orders[10]).toBe(10 - 2);
    expect(p.orders[23]).toBe(23);
    expect(p.close.orders).toBe(
      42 + 8 + HOURS_FROM(11).reduce((s, h) => s + h, 0),
    );
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
let lastSeries = 0;
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
    lastSeries = body.series.length;
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
  const DAYS_1_TO_28 = Array.from({ length: 28 }, (_, i) => i + 1);
  /** Stored predictions for `daysAgo`, each `orders` and `orders` × 100. */
  const storedFor =
    (daysAgo: number[], orders = 60) =>
    async (asked: number[]) =>
      new Map(
        asked
          .filter((d) => daysAgo.includes(d))
          .map((d) => [d, { orders, revenue: orders * 100 }] as const),
      );

  it("sends only today's two series once every calibration day has a stored forecast", async () => {
    mode = "ok";
    value = 4;
    const asked: number[][] = [];
    const model = await runModel(
      service,
      cleanHistory(history()),
      12,
      async (daysAgo) => {
        asked.push(daysAgo);
        return storedFor(DAYS_1_TO_28)(daysAgo);
      },
    );
    expect(asked).toEqual([DAYS_1_TO_28]);
    expect(lastSeries).toBe(2);
    expect(model.orders).toEqual(hours(4).slice(12));
    expect(model.rest).toEqual({ orders: 48, revenue: 48 });
    expect(model.backfill).toEqual([]);
    // At hour 12 each past day has 12 hours left: 120 orders and 12,000
    // revenue, against the stored 60 and 6,000, not today's model.
    expect(model.ratios).toHaveLength(28);
    expect(model.ratios[0]).toEqual({ daysAgo: 1, orders: 2, revenue: 2 });
  });

  it("backfills the most recent days without a stored forecast, up to the cap", async () => {
    mode = "ok";
    value = 4;
    const model = await runModel(
      service,
      cleanHistory(history()),
      12,
      storedFor([]),
    );
    expect(lastSeries).toBe(2 + 2 * BACKFILL_DAYS_PER_RUN);
    expect(model.backfill.map((b) => b.daysAgo)).toEqual(
      DAYS_1_TO_28.slice(0, BACKFILL_DAYS_PER_RUN),
    );
    expect(model.backfill[0]).toEqual({
      daysAgo: 1,
      orders: hours(4).slice(12),
      revenue: hours(4).slice(12),
      rest: { orders: 48, revenue: 48 },
    });
    // Rated against the backfilled 48; the days past the cap get no ratio.
    expect(model.ratios.map((r) => r.daysAgo)).toEqual(
      DAYS_1_TO_28.slice(0, BACKFILL_DAYS_PER_RUN),
    );
    expect(model.ratios[0]).toEqual({
      daysAgo: 1,
      orders: 120 / 48,
      revenue: 12_000 / 48,
    });
  });

  it("backfills only the days missing among the stored ones", async () => {
    mode = "ok";
    value = 4;
    const model = await runModel(
      service,
      cleanHistory(history()),
      12,
      storedFor(DAYS_1_TO_28.filter((d) => d !== 3 && d !== 20)),
    );
    expect(lastSeries).toBe(6);
    expect(model.backfill.map((b) => b.daysAgo)).toEqual([3, 20]);
    expect(model.ratios).toHaveLength(28);
    expect(model.ratios.find((r) => r.daysAgo === 3)?.orders).toBe(120 / 48);
    expect(model.ratios.find((r) => r.daysAgo === 4)?.orders).toBe(2);
  });

  it("skips calibration days whose forecast is 0", async () => {
    mode = "ok";
    value = -1;
    expect(
      (await runModel(service, cleanHistory(history()), 12, storedFor([])))
        .ratios,
    ).toEqual([]);
    value = 4;
    expect(
      (
        await runModel(
          service,
          cleanHistory(history()),
          12,
          storedFor(DAYS_1_TO_28, 0),
        )
      ).ratios,
    ).toEqual([]);
  });
});

describe("localDateBefore", () => {
  it("steps back calendar days across months and leap days", () => {
    expect(localDateBefore("2026-11-26", 0)).toBe("2026-11-26");
    expect(localDateBefore("2026-11-26", 28)).toBe("2026-10-29");
    expect(localDateBefore("2028-03-01", 1)).toBe("2028-02-29");
    expect(localDateBefore("2026-01-01", 1)).toBe("2025-12-31");
  });
});

describe("forecastStore", () => {
  const job = (connectionId: string, at = new Date()): ForecastJob => ({
    organizationId: "org",
    connectionId,
    timezone: "UTC",
    at: at.toISOString(),
    date: at.toLocaleDateString("en-CA", { timeZone: "UTC" }),
    hour: 12,
    backfill: [],
  });
  let loads = 0;
  const load = async () => {
    loads++;
    return history();
  };
  const none = async () => new Map();
  const serviceWarnings = (warn: { mock: { calls: unknown[][] } }) =>
    warn.mock.calls.filter((c) =>
      String(c[0]).includes("forecast service failed"),
    ).length;

  it("answers the model's forecast from the job's hour", async () => {
    mode = "ok";
    value = 3;
    const model = await forecastStore(
      serviceAt("store-ok"),
      job("a"),
      load,
      none,
    );
    expect(model?.hour).toBe(12);
    expect(model?.orders).toEqual(hours(3).slice(12));
    expect(model?.ratios).toHaveLength(BACKFILL_DAYS_PER_RUN);
  });

  it("reads the stored forecasts by the calibration days' local dates", async () => {
    mode = "ok";
    value = 3;
    const j = { ...job("dates"), date: "2026-11-26" };
    let asked: string[] = [];
    const model = await forecastStore(
      serviceAt("store-dates"),
      j,
      load,
      async (dates) => {
        asked = dates;
        return new Map([["2026-11-25", { orders: 40, revenue: 4000 }]]);
      },
    );
    expect(asked).toHaveLength(28);
    expect(asked.slice(0, 2)).toEqual(["2026-11-25", "2026-11-24"]);
    expect(asked.at(-1)).toBe("2026-10-29");
    expect(model?.ratios[0]).toEqual({ daysAgo: 1, orders: 3, revenue: 3 });
    expect(model?.backfill.map((b) => b.daysAgo)[0]).toBe(2);
  });

  it("answers null, without throwing, when the service or the lake fails", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const failing of ["500", "malformed", "short", "slow"] as const) {
        mode = failing;
        expect(
          await forecastStore(
            serviceAt(`store-${failing}`),
            job("a"),
            load,
            none,
          ),
        ).toBeNull();
      }
      mode = "ok";
      expect(
        await forecastStore(
          serviceAt("store-lake"),
          job("a"),
          () => Promise.reject(new Error("lake down")),
          none,
        ),
      ).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it("skips a job whose tick is over an hour old, without the lake or the model", async () => {
    mode = "ok";
    const [hitsBefore, loadsBefore] = [hits, loads];
    const late = job("a", new Date(Date.now() - 61 * 60_000));
    expect(
      await forecastStore(serviceAt("store-late"), late, load, none),
    ).toBeNull();
    expect([hits, loads]).toEqual([hitsBefore, loadsBefore]);
  });

  it("skips a failed service for the cooldown, logging once, then calls it again", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const down = serviceAt("cooldown", 300);
      mode = "500";
      expect(await forecastStore(down, job("a"), load, none)).toBeNull();
      mode = "ok";
      value = 3;
      const [hitsBefore, loadsBefore] = [hits, loads];
      // Another store, same service: nothing read, nothing called.
      expect(await forecastStore(down, job("b"), load, none)).toBeNull();
      expect([hits, loads]).toEqual([hitsBefore, loadsBefore]);
      expect(serviceWarnings(warn)).toBe(1);
      // Another service URL isn't cooling down.
      expect(
        (await forecastStore(serviceAt("elsewhere"), job("b"), load, none))
          ?.orders[0],
      ).toBe(3);
      await Bun.sleep(350);
      expect((await forecastStore(down, job("c"), load, none))?.orders[0]).toBe(
        3,
      );
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
        ["1", "2", "3"].map((id) => forecastStore(down, job(id), load, none)),
      );
      expect(out).toEqual([null, null, null]);
      expect(hits).toBe(before + 3);
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
      expect(
        await forecastStore(
          svc,
          job("x"),
          () => Promise.reject(new Error("lake down")),
          none,
        ),
      ).toBeNull();
      expect(serviceWarnings(warn)).toBe(0);
      expect((await forecastStore(svc, job("y"), load, none))?.orders[0]).toBe(
        5,
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("forecastJobs", () => {
  // 10:08 in São Paulo (UTC-3): hour 10 is under way, 40 buckets done.
  const at = new Date("2026-11-26T13:08:00Z");
  const read = {
    timezone: "America/Sao_Paulo",
    done: 40,
    backfill: [3],
  };

  it("asks for one forecast per store whose day the sweep read, in every org", () => {
    const jobs = forecastJobs(
      [
        { organizationId: "x", connectionId: "a", day: read },
        {
          organizationId: "y",
          connectionId: "b",
          day: { timezone: "Europe/Lisbon", done: 52, backfill: [] },
        },
        // The sweep couldn't read this one's day.
        { organizationId: "x", connectionId: "c" },
      ],
      at,
    );
    expect(jobs).toEqual([
      {
        organizationId: "x",
        connectionId: "a",
        timezone: "America/Sao_Paulo",
        at: at.toISOString(),
        date: "2026-11-26",
        hour: 10,
        backfill: [3],
      },
      {
        organizationId: "y",
        connectionId: "b",
        timezone: "Europe/Lisbon",
        at: at.toISOString(),
        date: "2026-11-26",
        hour: 13,
        backfill: [],
      },
    ]);
  });

  it("asks for nothing when the sweep read no store", () => {
    expect(forecastJobs([], at)).toEqual([]);
    expect(
      forecastJobs([{ organizationId: "x", connectionId: "c" }], at),
    ).toEqual([]);
  });

  it("names the same workflow on every tick of a store hour, and another one per store, day and hour", () => {
    const at = (iso: string, done: number) =>
      forecastJobs(
        [
          {
            organizationId: "on",
            connectionId: "a",
            day: { ...read, done },
          },
        ],
        new Date(iso),
      ).map(forecastWorkflowId)[0];
    // 10:08, 10:13 and 10:58 local: hour 10.
    const hour10 = at("2026-11-26T13:08:00Z", 40);
    expect(at("2026-11-26T13:13:00Z", 41)).toBe(hour10);
    expect(at("2026-11-26T13:58:00Z", 43)).toBe(hour10);
    const ids = [
      hour10,
      at("2026-11-26T14:08:00Z", 44),
      at("2026-11-27T13:08:00Z", 40),
      forecastWorkflowId({
        ...forecastJobs(
          [{ organizationId: "on", connectionId: "b", day: read }],
          new Date("2026-11-26T13:08:00Z"),
        )[0]!,
      }),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("withModel", () => {
  // At 10:30 UTC: buckets 40 and 41 of hour 10 are in, 1 order and 100 each.
  const at = new Date("2026-11-26T10:30:00Z");
  const day = storeDay(42);
  const view = () => buildDayView(day, at);
  const stored = (hour: number, minutesAgo: number, value = 5) => ({
    hour,
    orders: new Array<number>(24 - hour).fill(value),
    revenue: new Array<number>(24 - hour).fill(value * 100),
    rest: { orders: (24 - hour) * value, revenue: (24 - hour) * value * 100 },
    ratios: [{ daysAgo: 1, orders: 1.5, revenue: 0.5 }],
    computedAt: new Date(at.getTime() - minutesAgo * 60_000),
  });

  it("projects from a forecast of the hour under way", () => {
    const v = withModel(view(), day, stored(10, 22), at);
    const p = v.forecast.projection!;
    expect(p.orders[10]).toBe(3);
    expect(p.orders[11]).toBe(5);
    expect(p.close.orders).toBe(42 + 3 + 13 * 5);
    expect(p.paths).toHaveLength(1);
    expect(p.paths[0]!.orders[23]).toBeCloseTo((3 + 13 * 5) * 1.5);
  });

  it("projects from a forecast of the hour before, under 75 minutes old", () => {
    const v = withModel(view(), day, stored(9, 74, 7), at);
    const p = v.forecast.projection!;
    expect(p.orders[9]).toBe(0);
    expect(p.orders[10]).toBe(7 - 2);
    expect(p.close.orders).toBe(42 + 5 + 13 * 7);
  });

  it("keeps the baseline without a forecast, or with a stale or misshapen one", () => {
    const base = view();
    expect(withModel(base, day, null, at)).toBe(base);
    // Older than 75 minutes.
    expect(withModel(base, day, stored(9, 76), at)).toBe(base);
    // Two hours back, or from an hour not reached yet.
    expect(withModel(base, day, stored(8, 30), at)).toBe(base);
    expect(withModel(base, day, stored(11, 0), at)).toBe(base);
    expect(
      withModel(base, day, { ...stored(10, 10), orders: [1, 2] }, at),
    ).toBe(base);
  });

  it("gives the headline and the expected line past now the same rest of day", () => {
    for (const forecast of [stored(10, 10), stored(9, 70, 0)]) {
      const base = view();
      const v = withModel(base, day, forecast, at);
      const hour = Math.floor(day.done / 4);
      const fullHours = HOURS_FROM(0)
        .slice(0, hour)
        .reduce((s, h) => s + (v.orders.today[h] ?? 0), 0);
      const line = v.orders.expected.slice(hour).reduce((s, e) => s + e, 0);
      expect(v.headline.projected).toBe(v.forecast.projection!.close.orders);
      expect(fullHours + line).toBeCloseTo(v.headline.projected);
      // Hours gone and the bands stay the baseline's.
      expect(v.orders.expected.slice(0, hour)).toEqual(
        base.orders.expected.slice(0, hour),
      );
      expect(v.orders.alertAt).toEqual(base.orders.alertAt);
      expect(v.orders.warnAt).toEqual(base.orders.warnAt);
      expect(v.verdicts).toEqual(base.verdicts);
    }
  });
});
