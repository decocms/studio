/**
 * The Monitor's sales projection from the Timestral forecasting model, for
 * every monitored store: orders and revenue per local clock hour, 112 days of
 * context. A batch takes the model tens of seconds, so the
 * order-monitor sweep runs it once per store and local hour, off the alert
 * path (`dbos-order-monitor.ts`), and stores it; the day view maps the stored
 * forecast onto what's in so far. Alerts keep judging by the baseline. Without
 * a fresh forecast the day view keeps the baseline's projection, and a failed
 * service call skips the service for COOLDOWN_MS.
 *
 * The spread comes from the model's own misses: for each of the last 28 days,
 * how its actual rest of day compared with the forecast stored for it at the
 * same hour scales today's into one path. Backtested, the UI's middle 80% of
 * those paths held ~80% of closes. A day without a stored forecast at that
 * hour (a new store) is forecast along with today, BACKFILL_DAYS_PER_RUN at
 * most, and stored, so a store's steady state is two series per run.
 */

import type {
  OrderMonitorDay,
  OrderMonitorForecast,
} from "@decocms/shared/order-monitor";
import { z } from "zod";
import type { StoredOrderForecast } from "@/storage/order-monitor";
import type { HourlyDay } from "./order-lake";
import type { StoreDay } from "./order-rules";

const TIMEOUT_MS = 60_000;
/** After a failed call, the service is skipped this long. */
const COOLDOWN_MS = 60_000;
/** A job whose tick is older than this is skipped: the next hour's has taken over. */
const MAX_LAG_MS = 60 * 60_000;
/** The day view uses a forecast this old at most, from the hour under way or the one before. */
const MAX_AGE_MS = 75 * 60_000;
/** Days of history each series gives the model. */
export const CONTEXT_DAYS = 112;
/** A past day under this share of its trailing kept days' median is an ingest outage. */
const OUTAGE_SHARE = 0.25;
const TRAILING_DAYS = 28;
const CALIBRATION_DAYS = 28;
/** Calibration days come from this far back at most; the sweep keeps forecasts at least this long. */
export const CALIBRATION_WINDOW_DAYS = 35;
/** Past days without a stored forecast at the hour that one run forecasts along with today. */
export const BACKFILL_DAYS_PER_RUN = 14;
const HOURS = Array.from({ length: 24 }, (_, h) => h);

type Hours = (number | null)[];

export interface TimestralService {
  url: string;
  token?: string;
  timeoutMs?: number;
  cooldownMs?: number;
}

/** The service failed or timed out, as opposed to the lake or the history. */
class ForecastServiceError extends Error {
  constructor(
    message: string,
    readonly call: { latencyMs: number; seriesSent: number; timeout: boolean },
  ) {
    super(message);
  }
}

/** The paths' quantiles the UI's outer band spans, for the close's band. */
const BAND = [0.1, 0.9] as const;
const ERROR_CHARS = 200;

type PredictedRest = StoredOrderForecast["rest"];

/**
 * The model's median for the clock hours from `hour` on and its total, each
 * calibration day's actual ÷ forecast rest of day, and the past days this run
 * forecast for want of a stored forecast at `hour`, with the service call's
 * latency and batch size.
 */
export interface ModelForecast {
  hour: number;
  orders: number[];
  revenue: number[];
  rest: PredictedRest;
  latencyMs: number;
  seriesSent: number;
  ratios: { daysAgo: number; orders: number; revenue: number }[];
  backfill: {
    daysAgo: number;
    orders: number[];
    revenue: number[];
    rest: PredictedRest;
  }[];
}

/** The local date `days` before `date` (both YYYY-MM-DD). */
export const localDateBefore = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000)
    .toISOString()
    .slice(0, 10);

const sum = (xs: readonly (number | null)[]) =>
  xs.reduce<number>((s, v) => s + (v ?? 0), 0);

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/**
 * The days the model may read: a past day the ingest missed most of (under
 * OUTAGE_SHARE of its trailing kept days' median, or still backfilling)
 * becomes null, so the model sees it as missing instead of a day of no sales.
 * Day 0 is kept as is.
 */
export function cleanHistory(
  history: HourlyDay[],
  backfilling: readonly number[] = [],
): (HourlyDay | null)[] {
  const out: (HourlyDay | null)[] = history.map(() => null);
  const kept: number[] = [];
  for (let d = history.length - 1; d >= 1; d--) {
    const total = sum(history[d]!.orders);
    const trailing = kept.slice(-TRAILING_DAYS);
    if (
      total > 0 &&
      !backfilling.includes(d) &&
      (trailing.length === 0 || total >= OUTAGE_SHARE * median(trailing))
    ) {
      out[d] = history[d]!;
      kept.push(total);
    }
  }
  out[0] = history[0] ?? null;
  return out;
}

/**
 * The last CALIBRATION_DAYS kept days within CALIBRATION_WINDOW_DAYS, most
 * recent first, with each one's actual rest of day from `hour` on.
 */
export function calibrationDays(days: (HourlyDay | null)[], hour: number) {
  return days
    .map((d, daysAgo) => ({ d, daysAgo }))
    .filter(
      (x): x is { d: HourlyDay; daysAgo: number } =>
        x.daysAgo > 0 && x.daysAgo <= CALIBRATION_WINDOW_DAYS && !!x.d,
    )
    .slice(0, CALIBRATION_DAYS)
    .map(({ d, daysAgo }) => ({
      daysAgo,
      actual: {
        orders: sum(d.orders.slice(hour)),
        revenue: sum(d.revenue.slice(hour)),
      },
    }));
}

/**
 * One batch: the orders and revenue of each day in `forecast` (days ago, 0 =
 * today), each series the CONTEXT_DAYS × 24 hours before its day's `hour`,
 * left-padded with nulls to one length.
 */
export function buildRequest(
  days: (HourlyDay | null)[],
  hour: number,
  forecast: readonly number[],
) {
  const last = days.length - 1;
  const flat = (m: keyof HourlyDay): Hours =>
    [...days]
      .reverse()
      .flatMap((d) => d?.[m] ?? new Array<null>(24).fill(null));
  const orders = flat("orders");
  const revenue = flat("revenue");
  // Index of day `d`'s `hour` in the flattened series.
  const end = (d: number) => (last - d) * 24 + hour;
  const context = (s: Hours, d: number) =>
    s.slice(Math.max(0, end(d) - CONTEXT_DAYS * 24), end(d));
  const series = forecast.flatMap((d) => [
    context(orders, d),
    context(revenue, d),
  ]);
  const length = Math.max(...series.map((s) => s.length));
  return {
    series: series.map((s) => [
      ...new Array<null>(length - s.length).fill(null),
      ...s,
    ]),
    horizon: 24 - hour,
  };
}

const ForecastResponseSchema = z.object({
  quantiles: z.object({ "0.5": z.array(z.array(z.number())) }),
});

/**
 * The model's median per series and how long the call took; throws a
 * ForecastServiceError on a timeout, a non-200 or a body of another shape.
 */
export async function requestForecast(
  service: TimestralService,
  series: Hours[],
  horizon: number,
): Promise<{ median: number[][]; latencyMs: number }> {
  const start = performance.now();
  const latencyMs = () => Math.round(performance.now() - start);
  try {
    const median = await callService(service, series, horizon);
    return { median, latencyMs: latencyMs() };
  } catch (err) {
    throw new ForecastServiceError(
      err instanceof Error ? err.message : String(err),
      {
        latencyMs: latencyMs(),
        seriesSent: series.length,
        timeout: err instanceof Error && err.name === "TimeoutError",
      },
    );
  }
}

async function callService(
  service: TimestralService,
  series: Hours[],
  horizon: number,
): Promise<number[][]> {
  const res = await fetch(`${service.url.replace(/\/+$/, "")}/forecast`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(service.token ? { authorization: `Bearer ${service.token}` } : {}),
    },
    body: JSON.stringify({ series, horizon, quantiles: [0.5] }),
    signal: AbortSignal.timeout(service.timeoutMs ?? TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`forecast service answered ${res.status}`);
  const median = ForecastResponseSchema.parse(await res.json()).quantiles[
    "0.5"
  ];
  if (
    median.length !== series.length ||
    median.some((s) => s.length !== horizon)
  ) {
    throw new Error("forecast service answered another shape");
  }
  return median;
}

/**
 * Forecasts today and the calibration days `stored` has no row for
 * (BACKFILL_DAYS_PER_RUN at most), and rates each calibration day's actual
 * rest of day against its stored or backfilled forecast; a day forecast at 0,
 * whose stored run didn't answer (null), or past the backfill cap gets no
 * ratio.
 */
export async function runModel(
  service: TimestralService,
  days: (HourlyDay | null)[],
  hour: number,
  stored: (daysAgo: number[]) => Promise<Map<number, PredictedRest | null>>,
): Promise<ModelForecast> {
  const calibration = calibrationDays(days, hour);
  if (calibration.length === 0) throw new Error("no history to forecast from");
  const known = await stored(calibration.map((c) => c.daysAgo));
  const missing = calibration
    .map((c) => c.daysAgo)
    .filter((d) => !known.has(d))
    .slice(0, BACKFILL_DAYS_PER_RUN);
  const { series, horizon } = buildRequest(days, hour, [0, ...missing]);
  const { median, latencyMs } = await requestForecast(service, series, horizon);
  const rest = (i: number): PredictedRest => ({
    orders: sum(median[i]!.map((v) => Math.max(0, v))),
    revenue: sum(median[i + 1]!.map((v) => Math.max(0, v))),
  });
  const backfill = missing.map((daysAgo, i) => ({
    daysAgo,
    orders: median[2 + 2 * i]!,
    revenue: median[3 + 2 * i]!,
    rest: rest(2 + 2 * i),
  }));
  const predicted = new Map(known);
  for (const b of backfill) predicted.set(b.daysAgo, b.rest);
  return {
    hour,
    orders: median[0]!,
    revenue: median[1]!,
    rest: rest(0),
    latencyMs,
    seriesSent: series.length,
    ratios: calibration.flatMap(({ daysAgo, actual }) => {
      const p = predicted.get(daysAgo);
      return p && p.orders > 0 && p.revenue > 0
        ? [
            {
              daysAgo,
              orders: actual.orders / p.orders,
              revenue: actual.revenue / p.revenue,
            },
          ]
        : [];
    }),
    backfill,
  };
}

/** The local hour under way at the read's instant, and what day 0 has in it so far. */
const hourUnderWay = (day: StoreDay, m: "placed" | "revenue") => {
  const hour = Math.floor(day.now / 4);
  return {
    hour,
    inHour: sum(day.days[0][m].slice(hour * 4, Math.ceil(day.now))),
  };
};

/**
 * The model's day as the projection: the median per clock hour from the hour
 * under way (minus what's already in it, up to `now`), and per calibration day
 * its ratio × the median's running total, so `paths` keeps meaning how the
 * rest could go. `model.hour` may be the hour before the one under way.
 */
export function toProjection(
  baseline: OrderMonitorForecast,
  day: StoreDay,
  model: Pick<ModelForecast, "hour" | "orders" | "revenue" | "ratios">,
): OrderMonitorForecast {
  const today = day.days[0];
  const rest = (forecast: number[], m: "placed" | "revenue") => {
    const { hour, inHour } = hourUnderWay(day, m);
    return HOURS.map((h) =>
      h < hour
        ? 0
        : Math.max(
            0,
            (forecast[h - model.hour] ?? 0) - (h === hour ? inHour : 0),
          ),
    );
  };
  const orders = rest(model.orders, "placed");
  const revenue = rest(model.revenue, "revenue");
  const running = (xs: number[]) => {
    let acc = 0;
    return xs.map((x) => (acc += x));
  };
  const ordersBy = running(orders);
  const revenueBy = running(revenue);
  return {
    orders,
    revenue,
    close: {
      orders: sum(today.placed.slice(0, Math.ceil(day.now))) + sum(orders),
      revenue: sum(today.revenue.slice(0, Math.ceil(day.now))) + sum(revenue),
    },
    initial: baseline.initial,
    paths: model.ratios.map((r) => ({
      daysAgo: r.daysAgo,
      orders: ordersBy.map((v) => v * r.orders),
      revenue: revenueBy.map((v) => v * r.revenue),
    })),
  };
}

/**
 * The day view with the stored forecast as its projection, when it is from
 * the hour under way or the one before and at most MAX_AGE_MS old. The
 * headline and the expected line from the hour under way on come from the
 * same rest of day, so the cards and the chart agree; the bands stay the
 * baseline's, as the sweep judges by them.
 */
export function withModel(
  view: OrderMonitorDay,
  day: StoreDay,
  forecast: StoredOrderForecast | null,
  at: Date,
): OrderMonitorDay {
  const baseline = view.forecast.projection;
  const { hour, inHour } = hourUnderWay(day, "placed");
  const fresh =
    !!forecast &&
    (forecast.hour === hour || forecast.hour === hour - 1) &&
    at.getTime() - forecast.computedAt.getTime() <= MAX_AGE_MS &&
    forecast.orders.length === 24 - forecast.hour &&
    forecast.revenue.length === 24 - forecast.hour;
  if (!baseline || !forecast || !fresh) return view;
  const projection = toProjection(baseline, day, forecast);
  return {
    ...view,
    orders: {
      ...view.orders,
      expected: view.orders.expected.map((e, h) =>
        h < hour ? e : projection.orders[h]! + (h === hour ? inHour : 0),
      ),
    },
    headline: { ...view.headline, projected: projection.close.orders },
    forecast: { ...view.forecast, projection },
  };
}

/** One store's forecast for the sweep to run: its local day and hour under way as of the tick `at`. */
export interface ForecastJob {
  organizationId: string;
  connectionId: string;
  timezone: string;
  at: string;
  date: string;
  hour: number;
  /** Days back from `date` the ingest's history backfill still holds. */
  backfill: number[];
  /** As of the tick: the day so far, the part of it in the hour under way, and the baseline projection's close. */
  soFar: PredictedRest;
  inHour: PredictedRest;
  baselineClose: PredictedRest | null;
}

/** What the sweep read of a store's day for its forecast. */
export type SweptDay = Pick<
  ForecastJob,
  "timezone" | "backfill" | "soFar" | "inHour" | "baselineClose"
> & { done: number };

/** A store the sweep read, with what it read of the day; no `day` when the read failed. */
export interface SweptStore {
  organizationId: string;
  connectionId: string;
  day?: SweptDay;
}

/** The forecasts due at `at`: one per store whose day the sweep read. */
export function forecastJobs(
  stores: readonly SweptStore[],
  at: Date,
): ForecastJob[] {
  return stores.flatMap(({ organizationId, connectionId, day }) =>
    day
      ? [
          {
            organizationId,
            connectionId,
            timezone: day.timezone,
            at: at.toISOString(),
            date: at.toLocaleDateString("en-CA", { timeZone: day.timezone }),
            hour: Math.floor(day.done / 4),
            backfill: day.backfill,
            soFar: day.soFar,
            inHour: day.inHour,
            baselineClose: day.baselineClose,
          },
        ]
      : [],
  );
}

/** One workflow per store, local day and hour: every tick of the hour asks for the same one. */
export const forecastWorkflowId = (job: ForecastJob) =>
  `order-forecast:${job.connectionId}:${job.date}:${job.hour}`;

/** Service URL → when calling it again is allowed. */
const cooldowns = new Map<string, number>();
const coolingDown = (url: string) => (cooldowns.get(url) ?? 0) > Date.now();

/** Linear-interpolated quantile, as the UI's bands take it; `xs` is not empty. */
function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo]! + (s[Math.ceil(i)]! - s[lo]!) * (i - lo);
}

/**
 * The close the day view projects from this forecast at the job's tick, and
 * the band its calibration paths span there (the UI's outer band, 10%–90%);
 * no band without a ratio.
 */
export function closeAtTick(job: ForecastJob, model: ModelForecast) {
  const close = (forecast: number[], m: keyof PredictedRest) =>
    job.soFar[m] +
    sum(forecast.map((v, i) => Math.max(0, v - (i === 0 ? job.inHour[m] : 0))));
  const predClose = {
    orders: close(model.orders, "orders"),
    revenue: close(model.revenue, "revenue"),
  };
  const at = (q: number) => ({
    orders:
      job.soFar.orders +
      (predClose.orders - job.soFar.orders) *
        quantile(
          model.ratios.map((r) => r.orders),
          q,
        ),
    revenue:
      job.soFar.revenue +
      (predClose.revenue - job.soFar.revenue) *
        quantile(
          model.ratios.map((r) => r.revenue),
          q,
        ),
  });
  return {
    predClose,
    band: model.ratios.length > 0 ? { lo: at(BAND[0]), hi: at(BAND[1]) } : null,
  };
}

/** One job's run: the model's forecast when it answered, and the lake's days when it was read. */
export interface ForecastRun {
  status: "ok" | "failed" | "timeout";
  error: string | null;
  latencyMs: number | null;
  seriesSent: number;
  model: ModelForecast | null;
  /** Per day back, its total and whether the history's cleaning dropped it as an outage. */
  days: { orders: number; revenue: number; outage: boolean }[] | null;
}

const failedRun = (
  error: string,
  days: ForecastRun["days"] = null,
  call?: ForecastServiceError["call"],
): ForecastRun => ({
  status: call?.timeout ? "timeout" : "failed",
  error: error.slice(0, ERROR_CHARS),
  latencyMs: call?.latencyMs ?? null,
  seriesSent: call?.seriesSent ?? 0,
  model: null,
  days,
});

/**
 * Runs the model for the job, calibrated on the forecasts `loadPredicted`
 * has stored for the job's hour by local date. A late job, a service cooling
 * down or any failure answers a failed run. Never throws.
 */
export async function forecastStore(
  service: TimestralService,
  job: ForecastJob,
  loadHistory: () => Promise<HourlyDay[]>,
  loadPredicted: (
    dates: string[],
  ) => Promise<Map<string, PredictedRest | null>>,
): Promise<ForecastRun> {
  if (Date.now() - Date.parse(job.at) > MAX_LAG_MS) {
    return failedRun("over an hour late; the next hour's forecast took over");
  }
  if (coolingDown(service.url)) {
    return failedRun("service cooling down after a failure");
  }
  let days: ForecastRun["days"] = null;
  try {
    const history = await loadHistory();
    const kept = cleanHistory(history, job.backfill);
    days = history.map((d, i) => ({
      orders: sum(d.orders),
      revenue: sum(d.revenue),
      outage: !kept[i],
    }));
    const model = await runModel(service, kept, job.hour, async (daysAgo) => {
      const dates = daysAgo.map((d) => localDateBefore(job.date, d));
      const byDate = await loadPredicted(dates);
      return new Map(
        daysAgo.flatMap((d, i) =>
          byDate.has(dates[i]!)
            ? [[d, byDate.get(dates[i]!) ?? null] as const]
            : [],
        ),
      );
    });
    return {
      status: "ok",
      error: null,
      latencyMs: model.latencyMs,
      seriesSent: model.seriesSent,
      model,
      days,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (!(err instanceof ForecastServiceError)) {
      console.warn("[order-monitor] model forecast failed", {
        connectionId: job.connectionId,
        error,
      });
      return failedRun(error, days);
    }
    if (!coolingDown(service.url)) {
      // Concurrent failures land here once: the first starts the cooldown.
      const ms = service.cooldownMs ?? COOLDOWN_MS;
      cooldowns.set(service.url, Date.now() + ms);
      console.warn(
        `[order-monitor] forecast service failed, skipping it for ${ms / 1000} s`,
        { connectionId: job.connectionId, error },
      );
    }
    return failedRun(error, days, err.call);
  }
}
