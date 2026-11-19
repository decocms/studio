/**
 * The day's sales status, the way a sales team reports it: revenue, orders,
 * average ticket and items so far, each beside the same time of day a week, 4
 * weeks and a year back; then the projection, from what the day was projected
 * at before its first order to where it is heading now, and what the next
 * hours should bring to get there. One store's day, or several added up.
 */

import type {
  OrderMonitorDay,
  OrderMonitorForecast,
  OrderMonitorSales,
} from "@decocms/shared/order-monitor";
import { useT } from "@/i18n/use-t.ts";
import { relativeChange } from "@/layouts/main-panel-tabs/monitor-v8";
import { Trend } from "./parts";

const REFS = ["w1", "m1", "y1"] as const;
type Ref = (typeof REFS)[number];
const REF_LABEL: Record<Ref, string> = { w1: "W-1", m1: "M-1", y1: "Y-1" };
/** Hours listed ahead, the one under way first. */
const NEXT_HOURS = 4;

const clock = (bucket: number) =>
  `${String(Math.floor(bucket / 4) % 24).padStart(2, "0")}:${String((bucket % 4) * 15).padStart(2, "0")}`;

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

function addProjection(
  ps: OrderMonitorForecast[],
): OrderMonitorForecast | null {
  if (ps.length === 0) return null;
  const hours = (pick: (p: OrderMonitorForecast) => number[]) =>
    Array.from({ length: 24 }, (_, h) =>
      ps.reduce((s, p) => s + (pick(p)[h] ?? 0), 0),
    );
  const total = (pick: (p: OrderMonitorForecast) => number) =>
    ps.reduce((s, p) => s + pick(p), 0);
  return {
    orders: hours((p) => p.orders),
    revenue: hours((p) => p.revenue),
    close: {
      orders: total((p) => p.close.orders),
      revenue: total((p) => p.close.revenue),
    },
    initial: {
      orders: total((p) => p.initial.orders),
      revenue: total((p) => p.initial.revenue),
    },
  };
}

export function SalesStatus({ days }: { days: readonly OrderMonitorDay[] }) {
  const t = useT();
  // A day read from an API without the status yet.
  if (days.length === 0 || days.some((d) => !d.forecast?.soFar)) return null;
  const done = Math.min(...days.map((d) => d.done));
  const today = addSales(days.map((d) => d.forecast.soFar.today));
  const ref = Object.fromEntries(
    REFS.map((r) => [r, addRef(days, r)]),
  ) as Record<Ref, OrderMonitorSales | null>;
  const projections = days.map((d) => d.forecast.projection);
  const projection = projections.every((p) => p !== null)
    ? addProjection(projections)
    : null;

  // Stores in different currencies don't add up: no revenue, no ticket.
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
  const count = (n: number) => Math.round(n).toLocaleString();
  const ticket = (s: OrderMonitorSales) =>
    s.orders > 0 ? s.revenue / s.orders : null;

  const until = done >= 95 ? "23:59" : clock(done);
  const first = Math.floor(done / 4);
  const next = projection
    ? Array.from({ length: NEXT_HOURS }, (_, i) => first + i)
        .filter((h) => h < 24)
        .map((h) => ({
          h,
          orders: projection.orders[h] ?? 0,
          revenue: projection.revenue[h] ?? 0,
        }))
    : [];
  const pick = (x: { orders: number; revenue: number }) =>
    currency ? x.revenue : x.orders;
  const show = (x: { orders: number; revenue: number }) =>
    currency ? money(x.revenue) : count(x.orders);
  const nextTotal = {
    orders: next.reduce((s, x) => s + x.orders, 0),
    revenue: next.reduce((s, x) => s + x.revenue, 0),
  };
  const share =
    projection && pick(projection.close) > 0
      ? Math.min(1, pick(today) / pick(projection.close))
      : 0;

  const rows: {
    key: string;
    label: string;
    value: (s: OrderMonitorSales) => number | null;
    show: (v: number) => string;
  }[] = [
    ...(currency
      ? [
          {
            key: "revenue",
            label: t("monitor.sales.revenue"),
            value: (x: OrderMonitorSales) => x.revenue,
            show: (v: number) => money(v),
          },
        ]
      : []),
    {
      key: "orders",
      label: t("monitor.sales.orders"),
      value: (x) => x.orders,
      show: count,
    },
    ...(currency
      ? [
          {
            key: "ticket",
            label: t("monitor.sales.ticket"),
            value: ticket,
            show: (v: number) => money(v, 2),
          },
        ]
      : []),
    {
      key: "items",
      label: t("monitor.sales.items"),
      value: (x) => x.items,
      show: count,
    },
    {
      key: "perOrder",
      label: t("monitor.sales.perOrder"),
      value: (x) => (x.orders > 0 ? x.items / x.orders : null),
      show: (v) => v.toFixed(2),
    },
  ];

  return (
    <section className="surface flex flex-col gap-5 px-4 pt-4 pb-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm text-foreground/70">
          {t("monitor.sales.title")}
        </h3>
        <span className="text-meta tnum">
          {t("monitor.sales.span", { from: "00:00", to: until })}
        </span>
      </div>

      <div className="-mx-4 overflow-x-auto px-4">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="text-meta border-b border-border/50">
              <th className="py-2 pr-4 text-left font-normal" />
              <th className="py-2 pl-4 text-right font-normal">
                {t("monitor.sales.today")}
              </th>
              {REFS.map((r) => (
                <th key={r} className="py-2 pl-4 text-right font-normal">
                  {REF_LABEL[r]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const own = row.value(today);
              return (
                <tr
                  key={row.key}
                  className="border-b border-border/50 last:border-b-0"
                >
                  <th className="py-2.5 pr-4 text-left font-normal text-foreground/70">
                    {row.label}
                  </th>
                  <td className="tnum py-2.5 pl-4 text-right text-base font-medium whitespace-nowrap text-foreground">
                    {own === null ? "—" : row.show(own)}
                  </td>
                  {REFS.map((r) => {
                    const then = ref[r] ? row.value(ref[r]) : null;
                    return (
                      <td
                        key={r}
                        className="tnum py-2.5 pl-4 text-right whitespace-nowrap"
                      >
                        <span className="text-foreground/70">
                          {then === null ? "—" : row.show(then)}
                        </span>
                        <span className="inline-block w-14 text-right">
                          <Trend
                            change={relativeChange(own, then)}
                            better="up"
                            reference=""
                          />
                        </span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {projection && done < 95 && (
        <div className="grid gap-6 border-t border-border/50 pt-5 md:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-3">
            <span className="text-sm text-foreground/70">
              {t("monitor.sales.projection", { from: "00:00", to: "23:59" })}
            </span>
            <span className="tnum text-3xl text-foreground">
              {show(projection.close)}
            </span>
            <span className="text-meta flex flex-wrap items-center gap-x-1.5">
              <Trend
                change={relativeChange(
                  pick(projection.close),
                  pick(projection.initial),
                )}
                better="up"
                reference=""
              />
              {t("monitor.sales.initial", {
                amount: show(projection.initial),
              })}
            </span>
            <div className="flex flex-col gap-1.5 pt-1">
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-chart-1"
                  style={{ width: `${share * 100}%` }}
                />
              </div>
              <span className="text-meta">
                {t("monitor.sales.inSoFar", {
                  share: `${Math.round(share * 100)}%`,
                  time: until,
                })}
              </span>
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-3">
            <span className="text-sm text-foreground/70">
              {t("monitor.sales.nextHours")}
            </span>
            <dl className="grid grid-cols-[auto_1fr_auto] gap-x-4 text-sm">
              {next.map((x, i) => (
                <div
                  key={x.h}
                  className="col-span-3 grid grid-cols-subgrid items-baseline border-b border-border/50 py-2 last:border-b-0"
                >
                  <dt className="tnum text-foreground/70">
                    {i === 0
                      ? t("monitor.sales.untilNext", {
                          to: clock((x.h + 1) * 4),
                        })
                      : `${clock(x.h * 4)}–${clock((x.h + 1) * 4)}`}
                  </dt>
                  <dd className="tnum text-right text-foreground">{show(x)}</dd>
                  <dd className="tnum text-meta w-24 text-right">
                    {currency
                      ? t("monitor.sales.ordersCount", {
                          count: count(x.orders),
                        })
                      : null}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="text-meta">
              {t("monitor.sales.target", {
                amount: show({
                  orders: today.orders + nextTotal.orders,
                  revenue: today.revenue + nextTotal.revenue,
                }),
                until: clock(((next.at(-1)?.h ?? first) + 1) * 4),
              })}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
