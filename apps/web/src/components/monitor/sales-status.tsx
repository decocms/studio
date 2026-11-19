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

/** A reference day across stores: unknown when any store lacks it, so a total never mixes in a missing day. */
function addRef(days: readonly OrderMonitorDay[], ref: Ref) {
  const xs = days.map((d) => d.forecast.soFar[ref]);
  return xs.every((x) => x !== null) ? addSales(xs) : null;
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
): OrderMonitorForecast | null {
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
    // ponytail: stores' lows and highs added up, as if they all ran quiet or busy at once.
    range: {
      orders: {
        low: hours((p) => p.range.orders.low),
        high: hours((p) => p.range.orders.high),
      },
      revenue: {
        low: hours((p) => p.range.revenue.low),
        high: hours((p) => p.range.revenue.high),
      },
    },
  };
}

export function SalesStatus({
  days,
  conversion,
}: {
  days: readonly OrderMonitorDay[];
  /** The sites' conversion, when it's in scope. */
  conversion?: Kpi | null;
}) {
  const t = useT();
  // A day read from an API without the sales, or the projection's range, yet.
  const stale = (d: OrderMonitorDay) =>
    !d.forecast?.revenue ||
    (d.forecast.projection !== null && !d.forecast.projection.range);
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
  ) as Record<Ref, OrderMonitorSales | null>;
  const projections = days.map((d) => d.forecast.projection);
  const projection =
    done < 95 && projections.every((p) => p !== null)
      ? addProjection(projections)
      : null;

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

  const series = addSeries(
    days.map((d) => (currency ? d.forecast.revenue : d.orders)),
  );
  const ahead = projection
    ? currency
      ? projection.revenue
      : projection.orders
    : null;
  const range = projection
    ? projection.range[currency ? "revenue" : "orders"]
    : null;
  const hasW1 = ref.w1 !== null;
  const now = done / 4;
  const hour = Math.floor(now);
  const until = done >= 95 ? "23:59" : clock(done);

  // Cumulative, at each hour mark and at the instant the day has reached.
  const marks = [...new Set([...HOURS, 24, now])].sort((a, b) => a - b);
  const w1At = (x: number) =>
    x === now && ref.w1 ? pick(ref.w1) : total(series.w1, x);
  // The cloud of where the day could be by `x`, from now on.
  const cloud = (x: number): [number, number] | null => {
    if (!range || x < now) return null;
    const at = Math.ceil(x) - 1;
    return x === now || at < 0
      ? [pick(today), pick(today)]
      : [pick(today) + range.low[at]!, pick(today) + range.high[at]!];
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
    band: cloud(x),
  }));
  const bars = HOURS.map((h) => ({
    x: h + 0.5,
    today: series.today[h],
    w1: hasW1 ? series.w1[h]! : null,
  }));
  // The hour under way, against W-1 up to the same minute.
  const w1Partial = ref.w1 ? pick(ref.w1) - total(series.w1, hour) : null;
  const rows = HOURS.filter(
    (h) => h >= hour - HOURS_BEFORE && h <= hour + (ahead ? HOURS_AFTER : 0),
  ).map((h) => {
    const partial = h === hour && live;
    return {
      h,
      partial,
      value: h <= hour ? (series.today[h] ?? 0) : null,
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
      refs: REFS.map((r) =>
        relativeChange(today.orders, ref[r]?.orders ?? null),
      ),
    },
    currency && {
      key: "ticket",
      label: t("monitor.sales.ticket"),
      value: ticket(today) === null ? "—" : money(ticket(today)!),
      refs: REFS.map((r) =>
        relativeChange(ticket(today), ref[r] ? ticket(ref[r]) : null),
      ),
    },
    {
      key: "items",
      label: t("monitor.sales.items"),
      value:
        perOrder(today) === null
          ? count(today.items)
          : `${count(today.items)} · ${t("monitor.sales.perOrder", { n: perOrder(today)!.toFixed(2) })}`,
      refs: REFS.map((r) => relativeChange(today.items, ref[r]?.items ?? null)),
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
        <span className="text-meta">{t("monitor.sales.source")}</span>
      </header>

      <div className="grid border-b border-border/50 sm:grid-cols-2">
        <div className="flex flex-col gap-1 p-4">
          <span className="text-meta">
            {t("monitor.sales.captured", { from: "00:00", to: until })}
          </span>
          <span className="tnum text-3xl font-medium text-foreground">
            {show(pick(today))}
          </span>
          <span className="flex flex-wrap gap-x-3 gap-y-0.5">
            {REFS.map((r) => (
              <Trend
                key={r}
                change={relativeChange(
                  pick(today),
                  ref[r] ? pick(ref[r]) : null,
                )}
                better="up"
                reference={
                  r === "w1"
                    ? t("monitor.sales.vsLast", { weekday })
                    : refLabel[r]
                }
              />
            ))}
          </span>
        </div>
        {projection && (
          <div className="flex flex-col gap-1 border-t border-border/50 p-4 sm:border-t-0 sm:border-l">
            <span className="text-meta">
              {t("monitor.sales.projection", { to: "23:59" })}
            </span>
            <span className="tnum text-3xl font-medium text-success">
              {show(pick(projection.close))}
            </span>
            <span className="text-meta tnum flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
              {range && (
                <>
                  {t("monitor.sales.between", {
                    low: show(pick(today) + range.low[23]!),
                    high: show(pick(today) + range.high[23]!),
                  })}
                  <span aria-hidden>·</span>
                </>
              )}
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
            </span>
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
                  cursor={{ stroke: "var(--border)", strokeDasharray: "4 4" }}
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
                        {p.projected !== null && p.today === null && (
                          <span>
                            {t("monitor.sales.projected")}: {show(p.projected)}
                          </span>
                        )}
                        {p.band && p.today === null && (
                          <span className="text-muted-foreground">
                            {t("monitor.sales.between", {
                              low: show(p.band[0]),
                              high: show(p.band[1]),
                            })}
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
                {range && (
                  <Area
                    type="monotone"
                    dataKey="band"
                    stroke="none"
                    fill={COLOR_TODAY}
                    fillOpacity={0.16}
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
            {range && (
              <Legend
                line={<span className="h-2.5 w-4 rounded-sm bg-chart-1/20" />}
              >
                {t("monitor.sales.rangeLegend")}
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
