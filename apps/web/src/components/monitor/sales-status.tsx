/**
 * The day's sales status, the way a sales team reports it: revenue, orders,
 * average ticket and items so far, each beside the same time of day a week, 4
 * weeks and a year back; then the projection, from what the day was projected
 * at before its first order to where it is heading now, and what the next
 * hours should bring to get there. One store's day, or several added up.
 */

import type { ReactNode } from "react";
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

function Measure({
  title,
  value,
  sub,
  refs,
}: {
  title: string;
  value: string;
  sub?: string;
  refs: { ref: Ref; value: string | null; change: number | null }[];
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm text-foreground/70">{title}</span>
        <span className="tnum truncate text-3xl text-foreground">{value}</span>
        {sub && <span className="text-meta">{sub}</span>}
      </div>
      <dl className="flex flex-col gap-1">
        {refs.map((r) => (
          <div key={r.ref} className="flex items-baseline gap-2 text-sm">
            <dt className="text-meta w-8 shrink-0">{REF_LABEL[r.ref]}</dt>
            <dd className="tnum min-w-0 flex-1 truncate text-foreground/80">
              {r.value ?? "—"}
            </dd>
            <dd className="shrink-0">
              <Trend change={r.change} better="up" reference="" />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
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
  const perOrder = (s: OrderMonitorSales) =>
    s.orders > 0 ? (s.items / s.orders).toFixed(2) : "—";
  const refsOf = (
    pick: (s: OrderMonitorSales) => number | null,
    show: (s: OrderMonitorSales) => string,
  ) =>
    REFS.map((r) => {
      const s = ref[r];
      return {
        ref: r,
        value: s ? show(s) : null,
        change: s ? relativeChange(pick(today), pick(s)) : null,
      };
    });

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
  const top = Math.max(1, ...next.map(pick));
  const nextTotal = {
    orders: next.reduce((s, x) => s + x.orders, 0),
    revenue: next.reduce((s, x) => s + x.revenue, 0),
  };
  const share =
    projection && pick(projection.close) > 0
      ? Math.min(1, pick(today) / pick(projection.close))
      : 0;

  const measures: ReactNode[] = [];
  if (currency) {
    measures.push(
      <Measure
        key="revenue"
        title={t("monitor.sales.revenue")}
        value={money(today.revenue, 2)}
        refs={refsOf(
          (s) => s.revenue,
          (s) => money(s.revenue),
        )}
      />,
    );
  }
  measures.push(
    <Measure
      key="orders"
      title={t("monitor.sales.orders")}
      value={count(today.orders)}
      refs={refsOf(
        (s) => s.orders,
        (s) => count(s.orders),
      )}
    />,
  );
  if (currency) {
    const own = ticket(today);
    measures.push(
      <Measure
        key="ticket"
        title={t("monitor.sales.ticket")}
        value={own === null ? "—" : money(own, 2)}
        refs={refsOf(ticket, (s) => {
          const v = ticket(s);
          return v === null ? "—" : money(v, 2);
        })}
      />,
    );
  }
  measures.push(
    <Measure
      key="items"
      title={t("monitor.sales.items")}
      value={count(today.items)}
      sub={t("monitor.sales.perOrder", { n: perOrder(today) })}
      refs={refsOf(
        (s) => s.items,
        (s) =>
          `${count(s.items)} · ${t("monitor.sales.perOrder", { n: perOrder(s) })}`,
      )}
    />,
  );

  return (
    <section className="surface flex flex-col gap-6 px-4 pt-4 pb-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm text-foreground/70">
          {t("monitor.sales.title")}
        </h3>
        <span className="text-meta">
          {t("monitor.sales.span", { from: "00:00", to: until })}
        </span>
      </div>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">{measures}</div>

      {projection && done < 95 && (
        <div className="grid gap-6 border-t border-border/50 pt-5 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <div className="flex min-w-0 flex-col gap-3">
            <span className="text-sm text-foreground/70">
              {t("monitor.sales.projection", { from: "00:00", to: "23:59" })}
            </span>
            <div className="flex flex-col gap-1">
              <span className="text-meta">{t("monitor.sales.updated")}</span>
              <span className="tnum text-3xl text-foreground">
                {show(projection.close)}
              </span>
              <span className="text-meta flex flex-wrap items-center gap-x-2">
                <span>
                  {t("monitor.sales.initial", {
                    amount: show(projection.initial),
                  })}
                </span>
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
            <div className="flex flex-col gap-1.5">
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-chart-1"
                  style={{ width: `${share * 100}%` }}
                />
              </div>
              <span className="text-meta">
                {t("monitor.sales.inSoFar", {
                  share: `${Math.round(share * 100)}%`,
                })}
              </span>
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <span className="text-sm text-foreground/70">
              {t("monitor.sales.nextHours")}
            </span>
            <ul className="flex flex-col">
              {next.map((x, i) => (
                <li
                  key={x.h}
                  className="flex h-9 items-center gap-3 border-b border-border/50 text-sm last:border-b-0"
                >
                  <span className="tnum w-24 shrink-0 text-foreground/70">
                    {i === 0
                      ? t("monitor.sales.untilNext", {
                          to: clock((x.h + 1) * 4),
                        })
                      : `${clock(x.h * 4)}–${clock((x.h + 1) * 4)}`}
                  </span>
                  <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                    <span
                      className="block h-full rounded-full bg-chart-2"
                      style={{ width: `${(pick(x) / top) * 100}%` }}
                    />
                  </span>
                  <span className="tnum w-28 shrink-0 text-right text-foreground">
                    {show(x)}
                  </span>
                  {currency && (
                    <span className="tnum text-meta hidden w-24 shrink-0 text-right sm:inline">
                      {t("monitor.sales.ordersCount", {
                        count: count(x.orders),
                      })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <p className="text-sm text-foreground">
              {t("monitor.sales.target", {
                amount: show(nextTotal),
                until: clock(((next.at(-1)?.h ?? first) + 1) * 4),
              })}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
