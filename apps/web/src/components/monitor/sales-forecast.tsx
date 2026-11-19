/**
 * Where today's sales are heading: the close, how much of it is in, and what
 * each of the next hours should bring to stay on pace, on the usual days or
 * on last year's same day. One store's day, or several added up.
 */

import { useState } from "react";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@decocms/ui/components/toggle-group.tsx";
import type {
  OrderMonitorDay,
  OrderMonitorForecast,
} from "@decocms/shared/order-monitor";
import { useT } from "@/i18n/use-t.ts";
import {
  formatCount,
  relativeChange,
} from "@/layouts/main-panel-tabs/monitor-v8";
import { Trend } from "./parts";

type Basis = "usual" | "lastYear";
const BASES: Basis[] = ["usual", "lastYear"];
/** Hours listed ahead, the one under way first. */
const NEXT_HOURS = 4;

const hourLabel = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;

function addUp(forecasts: OrderMonitorForecast[]): OrderMonitorForecast {
  const hours = (pick: (f: OrderMonitorForecast) => number[]) =>
    Array.from({ length: 24 }, (_, h) =>
      forecasts.reduce((s, f) => s + (pick(f)[h] ?? 0), 0),
    );
  const total = (pick: (f: OrderMonitorForecast) => number) =>
    forecasts.reduce((s, f) => s + pick(f), 0);
  return {
    orders: hours((f) => f.orders),
    revenue: hours((f) => f.revenue),
    close: {
      orders: total((f) => f.close.orders),
      revenue: total((f) => f.close.revenue),
    },
    reference: {
      orders: total((f) => f.reference.orders),
      revenue: total((f) => f.reference.revenue),
    },
  };
}

function money(n: number, currency: string): string {
  const compact = n >= 100_000;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: compact ? 1 : 0,
  }).format(n);
}

/** Today's days only: a closed day has nothing left to forecast. */
export function SalesForecast({ days }: { days: readonly OrderMonitorDay[] }) {
  const t = useT();
  const available = BASES.filter(
    (b) => days.length > 0 && days.every((d) => d.forecast?.[b]),
  );
  const [picked, setPicked] = useState<Basis>("usual");
  const basis = available.includes(picked) ? picked : available[0];
  const done = Math.min(...days.map((d) => d.done));
  if (!basis || done >= 96) return null;

  const f = addUp(days.map((d) => d.forecast[basis]!));
  const currencies = new Set(days.map((d) => d.forecast.currency));
  const [only] = currencies;
  // Stores in different currencies don't add up: count orders instead.
  const currency =
    currencies.size === 1 && only && f.close.revenue > 0 ? only : null;
  const measure = (o: number, r: number) =>
    currency ? money(r, currency) : formatCount(Math.round(o));
  const soFar = {
    orders: days.reduce((s, d) => s + d.forecast.soFar.orders, 0),
    revenue: days.reduce((s, d) => s + d.forecast.soFar.revenue, 0),
  };
  const close = currency ? f.close.revenue : f.close.orders;
  const inSoFar = currency ? soFar.revenue : soFar.orders;
  const share = close > 0 ? Math.min(1, inSoFar / close) : 0;
  const nowTime = `${String(Math.floor(done / 4)).padStart(2, "0")}:${String((done % 4) * 15).padStart(2, "0")}`;

  const first = Math.floor(done / 4);
  const next = Array.from({ length: NEXT_HOURS }, (_, i) => first + i)
    .filter((h) => h < 24)
    .map((h) => ({
      h,
      orders: f.orders[h] ?? 0,
      revenue: f.revenue[h] ?? 0,
    }));
  const value = (x: { orders: number; revenue: number }) =>
    currency ? x.revenue : x.orders;
  const top = Math.max(1, ...next.map(value));
  const nextTotal = {
    orders: next.reduce((s, x) => s + x.orders, 0),
    revenue: next.reduce((s, x) => s + x.revenue, 0),
  };
  const until = hourLabel((next.at(-1)?.h ?? first) + 1);
  const basisName = t(`monitor.forecast.basis.${basis}`);

  return (
    <section className="surface flex flex-col gap-5 px-4 pt-4 pb-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm text-foreground/70">
          {t("monitor.forecast.title")}
        </h3>
        {available.length > 1 && (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            aria-label={t("monitor.forecast.basis")}
            value={basis}
            onValueChange={(v) => v && setPicked(v as Basis)}
          >
            {available.map((b) => (
              <ToggleGroupItem
                key={b}
                value={b}
                className="flex-none px-2.5 text-xs font-normal"
              >
                {t(`monitor.forecast.basis.${b}`)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
      </div>

      <div className="grid gap-6 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-meta">{t("monitor.forecast.closeAt")}</span>
            <span className="tnum whitespace-nowrap text-4xl text-foreground">
              {measure(f.close.orders, f.close.revenue)}
            </span>
            <span className="text-meta flex flex-wrap items-center gap-x-2">
              {currency && (
                <span>
                  {t("monitor.forecast.orders", {
                    count: formatCount(Math.round(f.close.orders)),
                  })}
                </span>
              )}
              <Trend
                change={relativeChange(
                  close,
                  currency ? f.reference.revenue : f.reference.orders,
                )}
                better="up"
                reference={t(`monitor.forecast.vs.${basis}`)}
              />
            </span>
          </div>
          <div className="flex flex-col gap-2">
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-chart-1"
                style={{ width: `${share * 100}%` }}
              />
            </div>
            <span className="text-meta">
              {t("monitor.forecast.inSoFar", {
                amount: measure(soFar.orders, soFar.revenue),
                share: `${Math.round(share * 100)}%`,
              })}
            </span>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          <span className="text-meta">{t("monitor.forecast.nextHours")}</span>
          <ul className="flex flex-col">
            {next.map((x, i) => (
              <li
                key={x.h}
                className="flex h-9 items-center gap-3 border-b border-border/50 text-sm last:border-b-0"
              >
                <span className="tnum w-24 shrink-0 text-foreground/70">
                  {i === 0
                    ? t("monitor.forecast.untilNext", {
                        to: hourLabel(x.h + 1),
                      })
                    : `${hourLabel(x.h)}–${hourLabel(x.h + 1)}`}
                </span>
                <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full bg-chart-2"
                    style={{ width: `${(value(x) / top) * 100}%` }}
                  />
                </span>
                <span className="tnum w-24 shrink-0 text-right text-foreground">
                  {measure(x.orders, x.revenue)}
                </span>
                {currency && (
                  <span className="tnum text-meta hidden w-20 shrink-0 text-right sm:inline">
                    {t("monitor.forecast.orders", {
                      count: formatCount(Math.round(x.orders)),
                    })}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="text-sm text-foreground">
            {t("monitor.forecast.target", {
              amount: measure(nextTotal.orders, nextTotal.revenue),
              until,
              total: measure(
                soFar.orders + nextTotal.orders,
                soFar.revenue + nextTotal.revenue,
              ),
            })}
          </p>
        </div>
      </div>

      <p className="text-meta">
        {t(`monitor.forecast.how.${basis}`, {
          time: nowTime,
          share: `${Math.round(share * 100)}%`,
          basis: basisName,
        })}
      </p>
    </section>
  );
}
