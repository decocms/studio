/**
 * The day's sales, the way a sales team reads them: what's captured so far
 * against the same time a week back, where the day is projected to close
 * against where it opened, the day so far and ahead hour by hour, and orders,
 * average ticket, items and conversion beside W-1, M-1 and Y-1. One store's
 * day, or several added up.
 */

import type {
  OrderMonitorDay,
  OrderMonitorForecast,
  OrderMonitorSales,
  OrderMonitorSeries,
} from "@decocms/shared/order-monitor";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Area,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import { ChartContainer, ChartTooltip } from "@decocms/ui/components/chart.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { AXIS_TICK } from "@/layouts/task-board/analytics-sections";
import { relativeChange } from "@/layouts/main-panel-tabs/monitor-v8";
import type { Kpi } from "./board";
import { Trend } from "./parts";

const REFS = ["w1", "m1", "y1"] as const;
type Ref = (typeof REFS)[number];
const HOURS = Array.from({ length: 24 }, (_, h) => h);
/** Hours the table shows each side of the one under way. */
const HOURS_BEFORE = 3;
const HOURS_AFTER = 3;
/** An hour this far under W-1 draws red. */
const BELOW_W1 = 0.9;
const Y_AXIS_WIDTH = 44;
const COLOR_TODAY = "var(--chart-1)";
const COLOR_W1 = "var(--muted-foreground)";

type Pair = { orders: number; revenue: number };

const clock = (bucket: number) =>
  `${String(Math.floor(bucket / 4) % 24).padStart(2, "0")}:${String((bucket % 4) * 15).padStart(2, "0")}`;
const total = (xs: readonly (number | null)[], to = xs.length) =>
  xs.slice(0, to).reduce<number>((s, x) => s + (x ?? 0), 0);

const addSales = (xs: OrderMonitorSales[]): OrderMonitorSales => ({
  orders: xs.reduce((s, x) => s + x.orders, 0),
  revenue: xs.reduce((s, x) => s + x.revenue, 0),
  items: xs.reduce((s, x) => s + x.items, 0),
});

/**
 * A reference day across stores, like for like: only the stores that hold
 * it, today's side too, so a store the lake lacks that day doesn't read as growth.
 */
function addRef(days: readonly OrderMonitorDay[], ref: Ref) {
  const held = days.filter((d) => d.forecast.soFar[ref] !== null);
  return held.length === 0
    ? null
    : {
        ref: addSales(held.map((d) => d.forecast.soFar[ref]!)),
        today: addSales(held.map((d) => d.forecast.soFar.today)),
      };
}

/** Linear-interpolated quantile; `xs` is not empty. */
function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo]! + (s[Math.ceil(i)]! - s[lo]!) * (i - lo);
}

type Measure = "orders" | "revenue";
type Band = { low: number[]; high: number[] };

/**
 * Where the rest of the day could go: the reference days' paths, stores added
 * up day by day (a store without that day stands in with its projection), and
 * the quantiles between them: the middle half, and the middle 80%.
 */
export function bands(ps: OrderMonitorForecast[], m: Measure) {
  const days = [...new Set(ps.flatMap((p) => p.paths.map((x) => x.daysAgo)))];
  if (days.length === 0) return null;
  const paths = days.map((d) =>
    HOURS.map((h) =>
      ps.reduce((s, p) => {
        const x = p.paths.find((y) => y.daysAgo === d);
        return s + (x ? x[m][h]! : total(p[m], h + 1));
      }, 0),
    ),
  );
  const band = (lo: number, hi: number): Band => ({
    low: HOURS.map((h) =>
      quantile(
        paths.map((p) => p[h]!),
        lo,
      ),
    ),
    high: HOURS.map((h) =>
      quantile(
        paths.map((p) => p[h]!),
        hi,
      ),
    ),
  });
  return { inner: band(0.25, 0.75), outer: band(0.1, 0.9) };
}

const addSeries = (xs: OrderMonitorSeries[]) => ({
  today: HOURS.map((h) =>
    xs.every((x) => x.today[h] === null)
      ? null
      : xs.reduce((s, x) => s + (x.today[h] ?? 0), 0),
  ),
  w1: HOURS.map((h) => xs.reduce((s, x) => s + (x.w1[h] ?? 0), 0)),
});

function addProjection(
  ps: OrderMonitorForecast[],
): Omit<OrderMonitorForecast, "paths"> | null {
  if (ps.length === 0) return null;
  const hours = (pick: (p: OrderMonitorForecast) => number[]) =>
    HOURS.map((h) => ps.reduce((s, p) => s + (pick(p)[h] ?? 0), 0));
  const add = (pick: (p: OrderMonitorForecast) => number) =>
    ps.reduce((s, p) => s + pick(p), 0);
  return {
    orders: hours((p) => p.orders),
    revenue: hours((p) => p.revenue),
    close: {
      orders: add((p) => p.close.orders),
      revenue: add((p) => p.close.revenue),
    },
    initial: {
      orders: add((p) => p.initial.orders),
      revenue: add((p) => p.initial.revenue),
    },
  };
}

/** Stores past this many share "Others" in the stacked bars. */
const STACKED_STORES = 5;
const STACK_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];
const COLOR_OTHERS = "var(--muted-foreground)";

export function SalesStatus({
  days,
  titles,
  conversion,
  picker,
}: {
  days: readonly OrderMonitorDay[];
  /** Each day's store, for the bars stacked by store; parallel to `days`. */
  titles?: readonly string[];
  /** The sites' conversion, when it's in scope. */
  conversion?: Kpi | null;
  /** A store filter, in the header. */
  picker?: React.ReactNode;
}) {
  const t = useT();
  // A day read from an API without the sales, or the projection's paths, yet.
  const stale = (d: OrderMonitorDay) =>
    !d.forecast?.revenue ||
    (d.forecast.projection !== null && !d.forecast.projection.paths);
  if (days.length === 0 || days.some(stale)) return null;
  const first = days[0]!;
  const done = Math.min(...days.map((d) => d.done));
  const live =
    done < 96 &&
    new Date().toLocaleDateString("en-CA", { timeZone: first.timezone }) ===
      first.date;
  const today = addSales(days.map((d) => d.forecast.soFar.today));
  const ref = Object.fromEntries(
    REFS.map((r) => [r, addRef(days, r)]),
  ) as Record<Ref, ReturnType<typeof addRef>>;
  const projections = days.map((d) => d.forecast.projection);
  const held = projections.every((p) => p !== null) ? projections : null;
  const projection = done < 95 && held ? addProjection(held) : null;

  // Stores in different currencies don't add up: orders stand in for revenue.
  const currencies = new Set(days.map((d) => d.forecast.currency));
  const [only] = currencies;
  const currency = currencies.size === 1 && only ? only : null;
  const money = (n: number, fraction = 0) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency ?? "USD",
      minimumFractionDigits: fraction,
      maximumFractionDigits: fraction,
    }).format(n);
  const compact = (n: number) =>
    new Intl.NumberFormat(undefined, {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(n);
  const count = (n: number) => Math.round(n).toLocaleString();
  const pick = (x: Pair) => (currency ? x.revenue : x.orders);
  const show = (n: number) => (currency ? money(n) : count(n));
  /** Today against reference `r`, like for like. */
  const vs = (r: Ref, f: (s: OrderMonitorSales) => number | null) => {
    const x = ref[r];
    return x ? relativeChange(f(x.today), f(x.ref)) : null;
  };

  const storeSeries = (d: OrderMonitorDay) =>
    currency ? d.forecast.revenue : d.orders;
  const series = addSeries(days.map(storeSeries));
  const ahead = projection
    ? currency
      ? projection.revenue
      : projection.orders
    : null;
  const band =
    projection && held ? bands(held, currency ? "revenue" : "orders") : null;
  const hasW1 = ref.w1 !== null;
  const now = done / 4;
  const hour = Math.floor(now);
  // The hour under way has a bucket in; at :00 it hasn't started.
  const started = done % 4 !== 0;
  const until = done >= 95 ? "23:59" : clock(done);

  // W-1 up to the same minute: each store's own, or its whole hours.
  const w1Now = days.reduce((s, d) => {
    const w1 = d.forecast.soFar.w1;
    return s + (w1 ? pick(w1) : total(storeSeries(d).w1, hour));
  }, 0);
  // Cumulative, at each hour mark and at the instant the day has reached.
  const marks = [...new Set([...HOURS, 24, now])].sort((a, b) => a - b);
  const w1At = (x: number) => (x === now ? w1Now : total(series.w1, x));
  // Where the day could be by `x`, from now on.
  const cloud = (b: Band | undefined, x: number): [number, number] | null => {
    if (!b || x < now) return null;
    const at = Math.ceil(x) - 1;
    return x === now || at < 0
      ? [pick(today), pick(today)]
      : [pick(today) + b.low[at]!, pick(today) + b.high[at]!];
  };
  const curve = marks.map((x) => ({
    x,
    today: x <= now ? (x === now ? pick(today) : total(series.today, x)) : null,
    w1: hasW1 ? w1At(x) : null,
    // From where today's line ends: the hour under way's rest lands by its end.
    projected:
      ahead && x >= now
        ? pick(today) + (x === now ? 0 : total(ahead, x))
        : null,
    inner: cloud(band?.inner, x),
    outer: cloud(band?.outer, x),
  }));

  // Several stores: today's bars stacked by store, the biggest so far first.
  const stacked = days.length > 1 && titles?.length === days.length;
  const ranked = stacked
    ? days
        .map((d, i) => ({
          d,
          title: titles[i]!,
          so: pick(d.forecast.soFar.today),
        }))
        .sort((a, b) => b.so - a.so)
    : [];
  const stacks = [
    ...ranked.slice(0, STACKED_STORES).map((s, i) => ({
      key: `s${i}`,
      label: s.title,
      color: STACK_COLORS[i]!,
      days: [s.d],
    })),
    ...(ranked.length > STACKED_STORES
      ? [
          {
            key: "others",
            label: t("monitor.sales.others"),
            color: COLOR_OTHERS,
            days: ranked.slice(STACKED_STORES).map((s) => s.d),
          },
        ]
      : []),
  ];
  const bars = HOURS.map((h) => ({
    x: h + 0.5,
    today: series.today[h],
    w1: hasW1 ? series.w1[h]! : null,
    ...Object.fromEntries(
      stacks.map((s) => [
        s.key,
        series.today[h] === null
          ? null
          : s.days.reduce((n, d) => n + (storeSeries(d).today[h] ?? 0), 0),
      ]),
    ),
  }));
  // The hour under way, against W-1 up to the same minute.
  const w1Partial = w1Now - total(series.w1, hour);
  const rows = HOURS.filter(
    (h) => h >= hour - HOURS_BEFORE && h <= hour + (ahead ? HOURS_AFTER : 0),
  ).map((h) => {
    const partial = h === hour && live && started;
    const past = h < hour || (h === hour && (started || !live));
    return {
      h,
      partial,
      value: past ? (series.today[h] ?? 0) : null,
      expected: ahead ? ahead[h]! : null,
      w1: hasW1 ? (partial ? w1Partial : series.w1[h]!) : null,
    };
  });

  const weekday = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    timeZone: "UTC",
  }).format(new Date(`${first.date}T12:00:00Z`));
  const refLabel: Record<Ref, string> = {
    w1: t("monitor.sales.w1"),
    m1: t("monitor.sales.m1"),
    y1: t("monitor.sales.y1"),
  };
  const ticket = (s: OrderMonitorSales) =>
    s.orders > 0 ? s.revenue / s.orders : null;
  const perOrder = (s: OrderMonitorSales) =>
    s.orders > 0 ? s.items / s.orders : null;
  const conversionRefs = conversion?.references;
  const cards = [
    {
      key: "orders",
      label: t("monitor.sales.orders"),
      value: count(today.orders),
      refs: REFS.map((r) => vs(r, (x) => x.orders)),
    },
    currency && {
      key: "ticket",
      label: t("monitor.sales.ticket"),
      value: ticket(today) === null ? "—" : money(ticket(today)!),
      refs: REFS.map((r) => vs(r, ticket)),
    },
    {
      key: "items",
      label: t("monitor.sales.items"),
      value:
        perOrder(today) === null
          ? count(today.items)
          : `${count(today.items)} · ${t("monitor.sales.perOrder", { n: perOrder(today)!.toFixed(2) })}`,
      refs: REFS.map((r) => vs(r, (x) => x.items)),
    },
    conversion?.value != null &&
      conversionRefs && {
        key: "conversion",
        label: t("monitor.sales.conversion"),
        value: `${(conversion.value * 100).toFixed(2)}%`,
        // The sites' traffic has no M-1.
        refs: [
          relativeChange(conversion.value, conversionRefs.w1),
          null,
          relativeChange(conversion.value, conversionRefs.y1),
        ],
      },
  ].filter((c) => !!c);

  return (
    <section className="surface flex flex-col">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border/50 px-4 py-3">
        <div className="flex items-center gap-2 text-sm">
          <h3 className="font-medium text-foreground">
            {live
              ? t("monitor.sales.title")
              : t("monitor.sales.titleOn", { date: first.date })}
          </h3>
          {live && (
            <span className="text-meta tnum inline-flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-success" />
              {t("monitor.sales.live", { time: until })}
            </span>
          )}
        </div>
        <span className="flex items-center gap-3">
          <span className="text-meta">{t("monitor.sales.source")}</span>
          {picker}
        </span>
      </header>

      <div className="grid border-b border-border/50 sm:grid-cols-2">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 p-4">
          <div className="flex flex-col gap-1">
            <span className="text-meta">
              {t("monitor.sales.captured", { from: "00:00", to: until })}
            </span>
            <span className="tnum text-3xl font-medium text-foreground">
              {show(pick(today))}
            </span>
          </div>
          <ul className="flex flex-col gap-1 pt-1 text-sm">
            {REFS.map((r) => (
              <li key={r}>
                <Trend
                  change={vs(r, pick)}
                  better="up"
                  reference={
                    r === "w1"
                      ? t("monitor.sales.vsLast", { weekday })
                      : refLabel[r]
                  }
                />
              </li>
            ))}
          </ul>
        </div>
        {projection && (
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 border-t border-border/50 p-4 sm:border-t-0 sm:border-l">
            <div className="flex flex-col gap-1">
              <span className="text-meta">
                {t("monitor.sales.projection", { to: "23:59" })}
              </span>
              <span className="tnum text-3xl font-medium text-success">
                {show(pick(projection.close))}
              </span>
            </div>
            <ul className="text-meta tnum flex flex-col gap-1 pt-1">
              {band && (
                <li>
                  {t("monitor.sales.between", {
                    low: show(pick(today) + band.inner.low[23]!),
                    high: show(pick(today) + band.inner.high[23]!),
                  })}
                </li>
              )}
              <li className="inline-flex items-center gap-1.5">
                {t("monitor.sales.opened", {
                  amount: show(pick(projection.initial)),
                })}
                <Trend
                  change={relativeChange(
                    pick(projection.close),
                    pick(projection.initial),
                  )}
                  better="up"
                  reference=""
                />
              </li>
            </ul>
          </div>
        )}
      </div>

      <div className="grid md:grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
        <div className="flex min-w-0 flex-col gap-3 p-4">
          <div className="flex flex-col">
            <ChartContainer
              role="img"
              aria-label={t("monitor.sales.chart")}
              className="aspect-auto h-[220px] w-full"
              config={{
                today: { label: t("monitor.sales.today"), color: COLOR_TODAY },
              }}
            >
              <ComposedChart
                data={curve}
                margin={{ left: 0, right: 0, top: 8 }}
              >
                <defs>
                  <linearGradient id="sales-today" x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="0%"
                      stopColor={COLOR_TODAY}
                      stopOpacity={0.2}
                    />
                    <stop
                      offset="100%"
                      stopColor={COLOR_TODAY}
                      stopOpacity={0}
                    />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="4 4"
                  stroke="var(--border)"
                  strokeOpacity={0.5}
                  vertical={false}
                />
                <XAxis dataKey="x" type="number" domain={[0, 24]} hide />
                <YAxis
                  orientation="right"
                  axisLine={false}
                  tickLine={false}
                  tick={AXIS_TICK}
                  width={Y_AXIS_WIDTH}
                  tickFormatter={compact}
                />
                <ChartTooltip
                  cursor={{ stroke: "var(--foreground)", strokeOpacity: 0.4 }}
                  content={({ active, payload }) => {
                    const p = payload?.[0]?.payload as
                      | (typeof curve)[number]
                      | undefined;
                    if (!active || !p) return null;
                    return (
                      <div className="surface tnum flex flex-col gap-0.5 px-2.5 py-1.5 text-xs shadow-sm">
                        <span className="text-meta">
                          {clock(Math.round(p.x * 4))}
                        </span>
                        {p.today !== null && (
                          <span>
                            {t("monitor.sales.today")}: {show(p.today)}
                          </span>
                        )}
                        {p.outer && p.today === null && (
                          <span className="text-success">
                            {t("monitor.sales.best")}: {show(p.outer[1])}
                          </span>
                        )}
                        {p.projected !== null && p.today === null && (
                          <span>
                            {t("monitor.sales.projected")}: {show(p.projected)}
                          </span>
                        )}
                        {p.outer && p.today === null && (
                          <span className="text-destructive">
                            {t("monitor.sales.worst")}: {show(p.outer[0])}
                          </span>
                        )}
                        {p.w1 !== null && (
                          <span className="text-muted-foreground">
                            {refLabel.w1}: {show(p.w1)}
                          </span>
                        )}
                      </div>
                    );
                  }}
                />
                {live && (
                  <ReferenceLine
                    x={now}
                    stroke="var(--foreground)"
                    strokeOpacity={0.25}
                    strokeDasharray="2 3"
                  />
                )}
                {hasW1 && (
                  <Line
                    type="monotone"
                    dataKey="w1"
                    stroke={COLOR_W1}
                    strokeOpacity={0.6}
                    strokeDasharray="6 4"
                    strokeWidth={1.25}
                    dot={false}
                    activeDot={false}
                    isAnimationActive={false}
                  />
                )}
                {band && (
                  <Area
                    type="monotone"
                    dataKey="outer"
                    stroke="none"
                    fill={COLOR_TODAY}
                    fillOpacity={0.1}
                    activeDot={false}
                    isAnimationActive={false}
                  />
                )}
                {band && (
                  <Area
                    type="monotone"
                    dataKey="inner"
                    stroke="none"
                    fill={COLOR_TODAY}
                    fillOpacity={0.18}
                    activeDot={false}
                    isAnimationActive={false}
                  />
                )}
                {ahead && (
                  <Line
                    type="monotone"
                    dataKey="projected"
                    stroke={COLOR_TODAY}
                    strokeDasharray="2 3"
                    strokeWidth={1.5}
                    dot={false}
                    activeDot={false}
                    isAnimationActive={false}
                    connectNulls={false}
                  />
                )}
                <Area
                  type="monotone"
                  dataKey="today"
                  stroke={COLOR_TODAY}
                  strokeWidth={2}
                  fill="url(#sales-today)"
                  dot={false}
                  activeDot={{
                    r: 3,
                    stroke: "var(--background)",
                    strokeWidth: 2,
                  }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ChartContainer>
            <ChartContainer
              role="img"
              aria-label={t("monitor.sales.bars")}
              className="aspect-auto h-[84px] w-full"
              config={{
                today: { label: t("monitor.sales.today"), color: COLOR_TODAY },
              }}
            >
              <ComposedChart
                data={bars}
                margin={{ left: 0, right: 0, top: 4 }}
                barGap={1}
              >
                <XAxis
                  dataKey="x"
                  type="number"
                  domain={[0, 24]}
                  ticks={[0, 6, 12, 18, 24]}
                  axisLine={false}
                  tickLine={false}
                  tick={AXIS_TICK}
                  tickMargin={6}
                  tickFormatter={(h: number) =>
                    `${String(h).padStart(2, "0")}h`
                  }
                />
                <YAxis
                  orientation="right"
                  width={Y_AXIS_WIDTH}
                  tick={false}
                  tickLine={false}
                  axisLine={false}
                />
                {hasW1 && (
                  <Bar
                    dataKey="w1"
                    fill={COLOR_W1}
                    fillOpacity={0.25}
                    barSize={6}
                    radius={[2, 2, 0, 0]}
                    isAnimationActive={false}
                  />
                )}
                {stacked && (
                  <ChartTooltip
                    cursor={{ fill: "var(--muted)", fillOpacity: 0.4 }}
                    content={({ active, payload }) => {
                      const b = payload?.[0]?.payload as
                        | Record<string, number | null>
                        | undefined;
                      if (!active || !b || b.today === null) return null;
                      return (
                        <div className="surface tnum flex flex-col gap-0.5 px-2.5 py-1.5 text-xs shadow-sm">
                          <span className="text-meta">
                            {clock(Math.floor(b.x!) * 4)}
                          </span>
                          {stacks.map((st) => (
                            <span
                              key={st.key}
                              className="inline-flex items-center gap-1.5"
                            >
                              <span
                                className="size-2 rounded-sm"
                                style={{ background: st.color }}
                              />
                              {st.label}: {show(b[st.key] ?? 0)}
                            </span>
                          ))}
                        </div>
                      );
                    }}
                  />
                )}
                {stacked ? (
                  stacks.map((st, i) => (
                    <Bar
                      key={st.key}
                      dataKey={st.key}
                      stackId="today"
                      fill={st.color}
                      fillOpacity={0.85}
                      barSize={6}
                      radius={i === stacks.length - 1 ? [2, 2, 0, 0] : 0}
                      isAnimationActive={false}
                    />
                  ))
                ) : (
                  <Bar
                    dataKey="today"
                    barSize={6}
                    radius={[2, 2, 0, 0]}
                    isAnimationActive={false}
                  >
                    {bars.map((b, i) => (
                      <Cell
                        key={b.x}
                        fill={
                          i < hour &&
                          b.w1 !== null &&
                          (b.today ?? 0) < BELOW_W1 * b.w1
                            ? "var(--destructive)"
                            : COLOR_TODAY
                        }
                        fillOpacity={i === hour && live ? 0.5 : 0.85}
                      />
                    ))}
                  </Bar>
                )}
              </ComposedChart>
            </ChartContainer>
          </div>
          <div className="text-meta flex flex-wrap items-center gap-x-4 gap-y-1">
            <Legend
              line={<span className="h-0.5 w-4 rounded-full bg-chart-1" />}
            >
              {t("monitor.sales.today")}
            </Legend>
            {ahead && (
              <Legend
                line={
                  <span className="w-4 border-t-2 border-dotted border-chart-1" />
                }
              >
                {t("monitor.sales.projected")}
              </Legend>
            )}
            {band && (
              <Legend
                line={<span className="h-2.5 w-4 rounded-sm bg-chart-1/30" />}
              >
                {t("monitor.sales.inner")}
              </Legend>
            )}
            {band && (
              <Legend
                line={<span className="h-2.5 w-4 rounded-sm bg-chart-1/10" />}
              >
                {t("monitor.sales.outer")}
              </Legend>
            )}
            {hasW1 && (
              <Legend
                line={
                  <span className="w-4 border-t-2 border-dashed border-muted-foreground/60" />
                }
              >
                {refLabel.w1}
              </Legend>
            )}
          </div>
          {stacked && (
            <div className="text-meta flex flex-wrap items-center gap-x-4 gap-y-1">
              {stacks.map((st) => (
                <Legend
                  key={st.key}
                  line={
                    <span
                      className="size-2.5 rounded-sm"
                      style={{ background: st.color }}
                    />
                  }
                >
                  {st.label}
                </Legend>
              ))}
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-3 border-t border-border/50 p-4 md:border-t-0 md:border-l">
          <table className="tnum w-full table-fixed text-sm [&_td]:align-middle [&_td]:whitespace-nowrap">
            <colgroup>
              <col />
              <col className="w-[34%]" />
              {hasW1 && <col className="w-[34%]" />}
              {hasW1 && <col className="w-14" />}
            </colgroup>
            <thead>
              <tr className="text-meta border-b border-border/50">
                <th className="py-2 text-left font-normal">
                  {t("monitor.sales.hour")}
                </th>
                <th className="py-2 text-right font-normal">
                  {t("monitor.sales.capturedShort")}
                </th>
                {hasW1 && (
                  <th className="py-2 text-right font-normal">{refLabel.w1}</th>
                )}
                {hasW1 && <th />}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const future = row.value === null;
                const amount = future ? row.expected : row.value;
                return (
                  <tr
                    key={row.h}
                    className="border-b border-border/50 last:border-b-0"
                  >
                    <td
                      className={cn(
                        "py-2",
                        future ? "text-muted-foreground" : "text-foreground",
                      )}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        {clock(row.h * 4)}
                        {row.partial && (
                          <span
                            className="size-1.5 rounded-full bg-success"
                            title={t("monitor.sales.soFar")}
                          />
                        )}
                      </span>
                    </td>
                    <td
                      className={cn(
                        "py-2 text-right",
                        future ? "text-muted-foreground" : "text-foreground",
                      )}
                    >
                      {amount === null ? "—" : show(amount)}
                    </td>
                    {hasW1 && (
                      <td className="py-2 text-right text-muted-foreground">
                        {row.w1 === null ? "—" : show(row.w1)}
                      </td>
                    )}
                    {hasW1 && (
                      <td className="py-2 text-right">
                        {!future && (
                          <span className="inline-flex justify-end leading-none">
                            <Trend
                              change={relativeChange(row.value, row.w1)}
                              better="up"
                              reference=""
                            />
                          </span>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {live && (
            <p className="text-meta flex flex-wrap items-center gap-x-1.5">
              <span className="size-1.5 rounded-full bg-success" />
              {t("monitor.sales.soFarNote")}
              {ahead && <span aria-hidden>·</span>}
              {ahead && t("monitor.sales.expectedNote")}
            </p>
          )}
          {ahead && (
            <p className="text-meta">
              {t("monitor.sales.ahead", {
                amount: show(
                  total(ahead, Math.min(24, hour + HOURS_AFTER + 1)),
                ),
                until: clock(Math.min(96, (hour + HOURS_AFTER + 1) * 4)),
              })}
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 border-t border-border/50 lg:auto-cols-fr lg:grid-flow-col lg:grid-cols-none">
        {cards.map((c, i) => (
          <div
            key={c.key}
            className={cn(
              "flex flex-col gap-1 p-4",
              i % 2 === 1 && "border-l border-border/50",
              i >= 2 && "border-t border-border/50 lg:border-t-0",
              i >= 1 && "lg:border-l",
            )}
          >
            <span className="text-meta">{c.label}</span>
            <span className="tnum text-xl font-medium text-foreground">
              {c.value}
            </span>
            <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
              {REFS.map((r, j) => (
                <span key={r} className="inline-flex items-center gap-1">
                  <span className="text-muted-foreground">{refLabel[r]}</span>
                  {c.refs[j] === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <Trend change={c.refs[j]!} better="up" reference="" />
                  )}
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Legend({
  line,
  children,
}: {
  line: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {line}
      {children}
    </span>
  );
}
