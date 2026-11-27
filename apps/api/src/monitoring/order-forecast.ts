/**
 * The Monitor's sales projection from the Timestral forecasting model, for
 * orgs with `monitor_timestral_projection`: orders and revenue per local clock
 * hour, 112 days of context. Only the day view reads it; the sweep keeps
 * judging by the baseline. Any failure leaves the baseline's projection, and a
 * failed service call skips the service for COOLDOWN_MS.
 *
 * The spread comes from the model's own misses: each of the last 28 days is
 * forecast from the same hour, and how its actual rest of day compared with
 * that forecast scales today's into one path. Backtested, the UI's middle 80%
 * of those paths held ~80% of closes.
 */

import type { OrderMonitorForecast } from "@decocms/shared/order-monitor";
import { orgFlagEnabled } from "@decocms/shared/organization/schema";
import { z } from "zod";
import type { HourlyDay } from "./order-lake";
import type { StoreDay } from "./order-rules";

const TIMEOUT_MS = 3_000;
/** After a failed call, the service is skipped this long. */
const COOLDOWN_MS = 60_000;
/** Days of history each series gives the model. */
export const CONTEXT_DAYS = 112;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 500;
/** A past day under this share of its trailing kept days' median is an ingest outage. */
const OUTAGE_SHARE = 0.25;
const TRAILING_DAYS = 28;
const CALIBRATION_DAYS = 28;
const HOURS = Array.from({ length: 24 }, (_, h) => h);

type Hours = (number | null)[];

export interface TimestralService {
  url: string;
  token?: string;
  timeoutMs?: number;
  cooldownMs?: number;
}

/** The service failed or timed out, as opposed to the lake or the history. */
class ForecastServiceError extends Error {}

/** The model's median for the clock hours from `hour` on, and each calibration day's actual ÷ forecast rest of day. */
export interface ModelForecast {
  hour: number;
  orders: number[];
  revenue: number[];
  ratios: { daysAgo: number; orders: number; revenue: number }[];
}

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
 * One batch: today's orders and revenue, then the same pair for each of the
 * last CALIBRATION_DAYS kept days, each series the CONTEXT_DAYS × 24 hours
 * before its day's `hour`, left-padded with nulls to one length. `actual` is
 * each calibration day's rest of day from `hour` on.
 */
export function buildRequest(days: (HourlyDay | null)[], hour: number) {
  const last = days.length - 1;
  const flat = (m: keyof HourlyDay): Hours =>
    [...days]
      .reverse()
      .flatMap((d) => d?.[m] ?? new Array<null>(24).fill(null));
  const orders = flat("orders");
  const revenue = flat("revenue");
  // Index of day `d`'s `hour` in the flattened series.
  const end = (d: number) => (last - d) * 24 + hour;
  const calibration = days
    .map((d, daysAgo) => ({ d, daysAgo }))
    .filter(
      (x): x is { d: HourlyDay; daysAgo: number } => x.daysAgo > 0 && !!x.d,
    )
    .slice(0, CALIBRATION_DAYS)
    .map(({ d, daysAgo }) => ({
      daysAgo,
      actual: {
        orders: sum(d.orders.slice(hour)),
        revenue: sum(d.revenue.slice(hour)),
      },
    }));
  const context = (s: Hours, d: number) =>
    s.slice(Math.max(0, end(d) - CONTEXT_DAYS * 24), end(d));
  const series = [0, ...calibration.map((c) => c.daysAgo)].flatMap((d) => [
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
    calibration,
  };
}

const ForecastResponseSchema = z.object({
  quantiles: z.object({ "0.5": z.array(z.array(z.number())) }),
});

/** The model's median per series; throws a ForecastServiceError on a timeout, a non-200 or a body of another shape. */
export async function requestForecast(
  service: TimestralService,
  series: Hours[],
  horizon: number,
): Promise<number[][]> {
  try {
    return await callService(service, series, horizon);
  } catch (err) {
    throw new ForecastServiceError(
      err instanceof Error ? err.message : String(err),
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

export async function runModel(
  service: TimestralService,
  days: (HourlyDay | null)[],
  hour: number,
): Promise<ModelForecast> {
  const { series, horizon, calibration } = buildRequest(days, hour);
  if (calibration.length === 0) throw new Error("no history to forecast from");
  const median = await requestForecast(service, series, horizon);
  const rest = (i: number) => sum(median[i]!.map((v) => Math.max(0, v)));
  return {
    hour,
    orders: median[0]!,
    revenue: median[1]!,
    ratios: calibration.flatMap(({ daysAgo, actual }, i) => {
      const orders = rest(2 + 2 * i);
      const revenue = rest(3 + 2 * i);
      return orders > 0 && revenue > 0
        ? [
            {
              daysAgo,
              orders: actual.orders / orders,
              revenue: actual.revenue / revenue,
            },
          ]
        : [];
    }),
  };
}

/**
 * The model's day as the projection: the median per clock hour (the hour under
 * way minus what's already in it), and per calibration day its ratio × the
 * median's running total, so `paths` keeps meaning how the rest could go.
 */
export function toProjection(
  baseline: OrderMonitorForecast,
  day: StoreDay,
  model: ModelForecast,
): OrderMonitorForecast {
  const today = day.days[0];
  const { hour } = model;
  const rest = (forecast: number[], m: "placed" | "revenue") => {
    const inHour = sum(today[m].slice(hour * 4, day.done));
    return HOURS.map((h) =>
      h < hour
        ? 0
        : Math.max(0, forecast[h - hour]! - (h === hour ? inHour : 0)),
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
      orders: sum(today.placed.slice(0, day.done)) + sum(orders),
      revenue: sum(today.revenue.slice(0, day.done)) + sum(revenue),
    },
    initial: baseline.initial,
    paths: model.ratios.map((r) => ({
      daysAgo: r.daysAgo,
      orders: ordersBy.map((v) => v * r.orders),
      revenue: revenueBy.map((v) => v * r.revenue),
    })),
  };
}

export const forecastCacheKey = (
  organizationId: string,
  connectionId: string,
  date: string,
  hour: number,
) => JSON.stringify([organizationId, connectionId, date, hour]);

// In flight or done, so viewers of the same store hour share one forecast.
const cache = new Map<
  string,
  { expires: number; forecast: Promise<ModelForecast> }
>();

function cached(
  key: string,
  make: () => Promise<ModelForecast>,
): Promise<ModelForecast> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.forecast;
  for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
  while (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  const forecast = make();
  cache.set(key, { expires: now + CACHE_TTL_MS, forecast });
  // A failure isn't kept: the next view tries again.
  forecast.catch(() => {
    if (cache.get(key)?.forecast === forecast) cache.delete(key);
  });
  return forecast;
}

/** Service URL → when calling it again is allowed. */
const cooldowns = new Map<string, number>();
const coolingDown = (url: string) => (cooldowns.get(url) ?? 0) > Date.now();

/** `baseline` when the org's flag is off or the service is cooling down; otherwise the model's projection, or `baseline` when it fails. */
export async function modelProjection(args: {
  organizationId: string;
  connectionId: string;
  at: Date;
  day: StoreDay;
  baseline: OrderMonitorForecast;
  flags: Record<string, unknown> | null | undefined;
  service: TimestralService;
  loadHistory: () => Promise<HourlyDay[]>;
}): Promise<OrderMonitorForecast> {
  const { day, baseline } = args;
  if (
    !orgFlagEnabled(args.flags, "monitor_timestral_projection") ||
    coolingDown(args.service.url)
  ) {
    return baseline;
  }
  const hour = Math.floor(day.done / 4);
  const key = forecastCacheKey(
    args.organizationId,
    args.connectionId,
    args.at.toLocaleDateString("en-CA", { timeZone: day.timezone }),
    hour,
  );
  try {
    const model = await cached(key, async () =>
      runModel(
        args.service,
        cleanHistory(await args.loadHistory(), day.backfill?.days),
        hour,
      ),
    );
    return toProjection(baseline, day, model);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (!(err instanceof ForecastServiceError)) {
      console.warn(
        "[order-monitor] model forecast failed, using the baseline",
        {
          connectionId: args.connectionId,
          error,
        },
      );
    } else if (!coolingDown(args.service.url)) {
      // Concurrent failures land here once: the first starts the cooldown.
      const ms = args.service.cooldownMs ?? COOLDOWN_MS;
      cooldowns.set(args.service.url, Date.now() + ms);
      console.warn(
        `[order-monitor] forecast service failed, using the baseline for ${ms / 1000} s`,
        { connectionId: args.connectionId, error },
      );
    }
    return baseline;
  }
}
