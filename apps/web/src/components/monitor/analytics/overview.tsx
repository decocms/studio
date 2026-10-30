/**
 * The Deco Analytics overview: the five KPIs against the prior window, traffic
 * over time, the commerce funnel and where visitors come from. On a Deco site it
 * stands in for the Audience overview, so it also carries the pages, countries
 * and devices breakdowns, read from the `behaviour` view.
 */

import { useState } from "react";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@decocms/ui/components/toggle-group.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import { TrendChart } from "./charts";
import {
  firstRow,
  fmtDuration,
  fmtInt,
  fmtPct,
  kn,
  num,
  Panel,
  PrevChange,
  RankedChoice,
  RankedList,
  rowsOf,
  SectionError,
  SectionSkeleton,
  useSectionView,
  WithheldBadge,
} from "./panels";
import { countryOptions, deviceOptions } from "./behaviour";
import type { SectionProps } from "./types";

const METRICS = ["visitors", "pageviews", "events"] as const;
type Metric = (typeof METRICS)[number];

function metricLabel(metric: Metric, t: TFunction): string {
  switch (metric) {
    case "visitors":
      return t("monitor.analytics.panels.kpi.visitors");
    case "pageviews":
      return t("monitor.analytics.panels.kpi.pageviews");
    case "events":
      return t("monitor.analytics.panels.kpi.events");
    default: {
      const never: never = metric;
      return never;
    }
  }
}

export function DecoOverview(props: SectionProps) {
  const t = useT();
  const view = useSectionView(props, "overview");
  const breakdown = useSectionView(props, "behaviour");
  const [metric, setMetric] = useState<Metric>("visitors");

  if (view.isLoading) return <SectionSkeleton tiles={5} />;
  if (view.error) return <SectionError error={view.error} />;
  const data = view.data;

  const k = firstRow(data, "kpis") ?? {};
  const p = firstRow(data, "kpisPrev") ?? {};
  const covered = num(p.covered);
  const built = (num(k.sessions_built) ?? 0) > 0;
  const sampling = num(k.min_sampling);
  const series = rowsOf(data, "series");
  const shown = METRICS.filter((m) => series.some((r) => m in r));
  const active = shown.includes(metric) ? metric : "visitors";

  const tiles: {
    key: string;
    title: string;
    value: string;
    current: number | null;
    previous: number | null;
    better: "up" | "down";
    points?: boolean;
    chart?: Metric;
  }[] = [
    {
      key: "visitors",
      title: t("monitor.analytics.panels.kpi.visitors"),
      value: fmtInt(k.visitors),
      current: num(k.visitors),
      previous: num(p.visitors),
      better: "up",
      chart: "visitors",
    },
    {
      key: "pageviews",
      title: t("monitor.analytics.panels.kpi.pageviews"),
      value: fmtInt(k.pageviews),
      current: num(k.pageviews),
      previous: num(p.pageviews),
      better: "up",
      chart: "pageviews",
    },
    {
      key: "sessions",
      title: t("monitor.analytics.panels.kpi.sessions"),
      // An unbuilt session window is "not yet", not zero.
      value: built ? fmtInt(k.sessions) : "—",
      current: built ? num(k.sessions) : null,
      previous: num(p.sessions),
      better: "up",
    },
    {
      key: "bounce",
      title: t("monitor.analytics.panels.kpi.bounce"),
      value: num(k.bounce_pct) === null ? "—" : fmtPct(num(k.bounce_pct), 0),
      current: num(k.bounce_pct),
      previous: num(p.bounce_pct),
      better: "down",
      points: true,
    },
    {
      key: "duration",
      title: t("monitor.analytics.panels.kpi.duration"),
      value: fmtDuration(k.duration_s),
      current: num(k.duration_s),
      previous: num(p.duration_s),
      better: "up",
    },
  ];

  const funnel = firstRow(data, "funnel");
  const b = breakdown.data;

  return (
    <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {tiles.map((tile) => (
          <Panel
            key={tile.key}
            title={tile.title}
            value={tile.value}
            caption={
              <PrevChange
                current={tile.current}
                previous={tile.previous}
                covered={covered}
                better={tile.better}
                points={tile.points}
              />
            }
            onClick={
              tile.chart && shown.includes(tile.chart)
                ? () => setMetric(tile.chart ?? "visitors")
                : undefined
            }
          />
        ))}
      </div>
      {series.length > 1 && (
        <Panel
          title={metricLabel(active, t)}
          aside={
            <div className="flex items-center gap-2">
              {sampling !== null && sampling < 1 && (
                <WithheldBadge
                  label={t("monitor.analytics.panels.sampled", {
                    pct: Math.round(100 * sampling),
                  })}
                  tip={t("monitor.analytics.panels.sampledTip")}
                />
              )}
              {shown.length > 1 && (
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  value={active}
                  onValueChange={(v) => {
                    const m = METRICS.find((x) => x === v);
                    if (m) setMetric(m);
                  }}
                >
                  {shown.map((m) => (
                    <ToggleGroupItem
                      key={m}
                      value={m}
                      className="flex-none px-2.5 text-xs font-normal"
                    >
                      {metricLabel(m, t)}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              )}
            </div>
          }
        >
          <TrendChart
            points={series}
            metric={active}
            label={metricLabel(active, t)}
          />
        </Panel>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {funnel && <ConversionFunnel row={funnel} />}
        <RankedList
          title={t("monitor.analytics.panels.sources")}
          rows={kn(rowsOf(data, "sources"))}
          dim="source"
        />
      </div>
      {breakdown.isLoading ? (
        <div className="grid gap-4 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-64" />
          ))}
        </div>
      ) : (
        b && (
          <div className="grid gap-4 lg:grid-cols-3">
            <RankedList
              title={t("monitor.analytics.panels.pages")}
              rows={kn(rowsOf(b, "pages"))}
              dim="path"
            />
            <RankedChoice
              title={t("monitor.analytics.panels.countries")}
              options={countryOptions(rowsOf(b, "countries"), t)}
            />
            <RankedChoice
              title={t("monitor.analytics.panels.devices")}
              options={deviceOptions(
                kn(rowsOf(b, "devices")),
                kn(rowsOf(b, "os")),
                t,
              )}
            />
          </div>
        )
      )}
    </>
  );
}

/**
 * The commerce journey in distinct visitors per step. A step wider than the
 * one before it is a step that isn't instrumented, not a 300% conversion, so
 * its rate is withheld.
 */
function ConversionFunnel({ row }: { row: Record<string, unknown> }) {
  const t = useT();
  const steps = [
    { key: "viewed", label: t("monitor.analytics.panels.funnel.viewed") },
    { key: "view_item", label: t("monitor.analytics.panels.funnel.viewItem") },
    {
      key: "add_to_cart",
      label: t("monitor.analytics.panels.funnel.addToCart"),
    },
    { key: "purchase", label: t("monitor.analytics.panels.funnel.purchase") },
  ].map((s) => ({ ...s, n: num(row[s.key]) ?? 0 }));
  const top = Math.max(1, steps[0]?.n ?? 0);
  const viewed = steps[0]?.n ?? 0;
  const bought = steps[3]?.n ?? 0;
  const overall =
    bought <= viewed && viewed > 0 ? (100 * bought) / viewed : null;
  return (
    <Panel
      title={t("monitor.analytics.panels.funnel.title")}
      value={fmtPct(overall, 1)}
    >
      <ol className="flex flex-col gap-3">
        {steps.map((step, i) => {
          const prev = i > 0 ? (steps[i - 1]?.n ?? 0) : null;
          const wider = prev !== null && step.n > prev;
          return (
            <li key={step.key} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {step.label}
                </span>
                {prev === null ? null : wider ? (
                  <WithheldBadge
                    label={t("monitor.analytics.panels.funnel.wider")}
                    tip={t("monitor.analytics.panels.funnel.widerTip")}
                  />
                ) : (
                  <span className="text-meta tnum">
                    {t("monitor.analytics.panels.funnel.ofPrev", {
                      pct: fmtPct(prev ? (100 * step.n) / prev : null, 1),
                    })}
                  </span>
                )}
                <span className="tnum w-16 text-right text-foreground">
                  {fmtInt(step.n)}
                </span>
              </div>
              <div className="surface-inset h-2 overflow-hidden rounded-full">
                <div
                  className="h-full rounded-full bg-chart-1"
                  style={{
                    width: `${Math.min(100, Math.max(0.5, (100 * step.n) / top))}%`,
                  }}
                />
              </div>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
