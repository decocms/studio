/**
 * The operations strip: what the agents cost, how much they ran, and what runs
 * without anyone asking.
 *
 * Cloudflare-analytics-card shaped: a figure, its trend against the window's
 * own first half, then the chart AS the card's body rather than a decoration
 * under the number — gridlines and a scale on the right turn the shape into a
 * measurement. Wide-then-narrow rather than three equal boxes because the
 * three are not equal: money is the one number an operator answers for to
 * someone else. The per-project breakdown that used to be a side column
 * now opens as a dialog on click: the same chart, larger, plus a ranked list.
 *
 * Every figure here is measured, never estimated. Two things a fuller mock
 * might draw are missing for the same reason: the **budget bar** ("59% of
 * $2.0k") needs a ceiling no project or organization declares, and the
 * **Day/Week/Month range toggle** would switch between two windows we do not
 * compute. Both go in the day the field exists; a control that changes
 * nothing is worse than no control.
 */

import {
  type ButtonHTMLAttributes,
  forwardRef,
  type ReactNode,
  useState,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  BarChartSquare02,
  DotsVertical,
} from "@untitledui/icons";
import { Link } from "@tanstack/react-router";
import { Area, AreaChart, CartesianGrid, YAxis } from "recharts";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@decocms/ui/components/chart.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@decocms/ui/components/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { PROJECT_ROUTE } from "@/hooks/use-destination-route";
import type { MonthlyCost, RunsToday } from "./daily-pulse";
import { RhythmChart } from "./sparkline";

/** `$1.2k`, `$318`, `$8.97` — the magnitude a reader compares, never the cents
 *  on a four-figure number. Nothing spent is `$0`, not `$0.00`: two decimal
 *  places on a zero reads as a broken figure rather than an empty month. */
export function formatUsd(usd: number): string {
  if (usd <= 0) return "$0";
  if (usd >= 1000) return `$${(usd / 1000).toFixed(1)}k`;
  if (usd >= 10) return `$${Math.round(usd)}`;
  return `$${usd.toFixed(2)}`;
}

/** One card of the strip. The label strip is a fixed height so the three read
 *  off one baseline however different their bodies are. `interactive` adds a
 *  full-bleed, invisible overlay `<button>` — the mock's project card overlay
 *  pattern — rather than making the whole `<section>` a button: `action` (the
 *  kebab menu) needs its own independently-clickable button, and a button
 *  can't nest a button. The overlay sits behind `pointer-events-none` content
 *  so clicks fall through to it everywhere except `action`, which opts back
 *  into `pointer-events-auto`. */
const StatCard = forwardRef<
  HTMLButtonElement,
  {
    label: string;
    action?: ReactNode;
    className?: string;
    children: ReactNode;
    interactive?: boolean;
  } & ButtonHTMLAttributes<HTMLButtonElement>
>(function StatCard(
  { label, action, className, children, interactive, ...buttonProps },
  ref,
) {
  return (
    <section
      className={cn(
        "@container relative flex min-w-0 flex-col gap-3 rounded-2xl bg-card p-5 text-left card-shadow",
        interactive && "transition-colors hover:bg-accent/30",
        className,
      )}
    >
      {interactive && (
        <button
          type="button"
          ref={ref}
          aria-label={label}
          className="absolute inset-0 z-0 cursor-pointer rounded-2xl"
          {...buttonProps}
        />
      )}
      <div
        className={cn(
          "flex h-5 items-center justify-between gap-3",
          interactive && "pointer-events-none",
        )}
      >
        <h3 className="truncate text-sm text-muted-foreground">{label}</h3>
        {action && (
          <div
            className={cn(interactive && "relative z-10 pointer-events-auto")}
          >
            {action}
          </div>
        )}
      </div>
      {interactive ? (
        <div className="pointer-events-none flex min-w-0 flex-1 flex-col gap-2">
          {children}
        </div>
      ) : (
        children
      )}
    </section>
  );
});

/** The headline figure of a card, with the mock's trailing `<small>`: one size
 *  for all three, so the row reads as three readings of one machine. */
function Figure({ value, caption }: { value: string; caption?: ReactNode }) {
  return (
    <p className="flex items-baseline gap-2.5">
      <span className="tnum text-3xl font-semibold text-foreground leading-none">
        {value}
      </span>
      {caption && (
        <span className="min-w-0 truncate text-muted-foreground text-xs">
          {caption}
        </span>
      )}
    </p>
  );
}

/** Second half of the rhythm window against the first — the Cloudflare card's
 *  trend badge, but a raw delta rather than a percentage: at this scale (a
 *  handful of runs, single-digit dollars) a near-zero first half turns a
 *  percentage into noise ("↑7973%"), where the same swing as a count or a
 *  dollar amount stays readable. Matches the roster's own `Delta`. Null with
 *  nothing to compare against (a zero first half makes the ratio meaningless,
 *  not just large — the roster's rule too). */
function trendDelta(series: readonly number[]): number | null {
  const half = Math.floor(series.length / 2);
  const previous = series.slice(0, half).reduce((sum, day) => sum + day, 0);
  const current = series.slice(half).reduce((sum, day) => sum + day, 0);
  const diff = current - previous;
  return diff === 0 ? null : diff;
}

function TrendBadge({
  delta,
  format,
}: {
  delta: number | null;
  format: (value: number) => string;
}) {
  if (delta === null) return null;
  const up = delta > 0;
  const Glyph = up ? ArrowUp : ArrowDown;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 font-medium text-xs tabular-nums",
        up ? "text-success" : "text-muted-foreground",
      )}
    >
      <Glyph width={11} height={11} aria-hidden />
      {format(Math.abs(delta))}
    </span>
  );
}

/** The drill-down's "Top hosts" list: a bar per project, widest first. */
function TopProjectsList({
  byProject,
  projectsById,
  orgSlug,
}: {
  byProject: MonthlyCost["byProject"];
  projectsById: Map<string, VirtualMCPEntity>;
  orgSlug: string;
}) {
  const entries = byProject
    .map((entry) => ({ ...entry, project: projectsById.get(entry.projectId) }))
    .filter((entry) => entry.project);
  if (entries.length === 0) return null;
  const max = Math.max(...entries.map((entry) => entry.usd));

  return (
    <ul className="flex flex-col gap-4">
      {entries.map((entry) => (
        <li key={entry.projectId} className="flex items-center gap-4">
          <Link
            to={PROJECT_ROUTE.root}
            params={{ org: orgSlug, agentId: entry.projectId }}
            className="w-36 shrink-0 truncate text-foreground text-sm hover:underline"
          >
            {entry.project?.title}
          </Link>
          <div className="h-2 min-w-0 flex-1 rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${max > 0 ? (entry.usd / max) * 100 : 0}%` }}
            />
          </div>
          <span className="w-16 shrink-0 text-right text-foreground text-sm tabular-nums">
            {formatUsd(entry.usd)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** One line per top spender — the drill-down's "Requests by host over time",
 *  built on the same `ChartContainer`/`--chart-N` convention as the analytics
 *  tab's `AreaTrend`, so a multi-series money chart looks like every other
 *  multi-series chart in the product rather than a one-off. One shared axis
 *  (dollars): a second axis for a second unit is the chart mistake this
 *  avoids by construction — every line here is already the same unit. */
function CostTrendChart({
  costSeriesByProject,
  projectsById,
  days,
}: {
  costSeriesByProject: Map<string, readonly number[]>;
  projectsById: Map<string, VirtualMCPEntity>;
  days: number;
}) {
  const projectIds = [...costSeriesByProject.keys()].filter((id) =>
    projectsById.has(id),
  );
  if (projectIds.length === 0) return null;

  const rows = Array.from({ length: days }, (_, day) => {
    const row: Record<string, number> = { day };
    for (const id of projectIds)
      row[id] = costSeriesByProject.get(id)?.[day] ?? 0;
    return row;
  });
  const config = Object.fromEntries(
    projectIds.map((id, i) => [
      id,
      {
        label: projectsById.get(id)?.title ?? id,
        color: `var(--chart-${(i % 5) + 1})`,
      },
    ]),
  );

  return (
    <ChartContainer config={config} className="h-64 w-full">
      <AreaChart data={rows} margin={{ top: 8, right: -8, bottom: 8, left: 0 }}>
        <defs>
          {projectIds.map((id) => (
            <linearGradient
              key={id}
              id={`cost-grad-${id}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop
                offset="0%"
                stopColor={config[id]?.color}
                stopOpacity={0.2}
              />
              <stop
                offset="100%"
                stopColor={config[id]?.color}
                stopOpacity={0}
              />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid
          strokeDasharray="4 4"
          stroke="var(--border)"
          strokeOpacity={0.5}
          vertical={false}
        />
        <YAxis
          orientation="right"
          axisLine={false}
          tickLine={false}
          tick={{ fontSize: 11, fill: "var(--muted-foreground)", opacity: 0.7 }}
          tickFormatter={formatUsd}
          width={40}
          tickCount={4}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              indicator="line"
              hideLabel
              formatter={(value, name, item) => (
                <>
                  <div
                    className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                    style={{ background: item.color }}
                  />
                  <div className="flex flex-1 items-center justify-between leading-none">
                    <span className="text-muted-foreground">{name}</span>
                    <span className="font-medium text-foreground tabular-nums">
                      {formatUsd(Number(value))}
                    </span>
                  </div>
                </>
              )}
            />
          }
        />
        {projectIds.map((id) => (
          <Area
            key={id}
            type="linear"
            dataKey={id}
            name={config[id]?.label}
            stroke={config[id]?.color}
            strokeWidth={2}
            fill={`url(#cost-grad-${id})`}
            dot={false}
            activeDot={{
              r: 4,
              fill: config[id]?.color,
              stroke: "var(--background)",
              strokeWidth: 2,
            }}
            animationDuration={300}
          />
        ))}
        <ChartLegend content={<ChartLegendContent />} />
      </AreaChart>
    </ChartContainer>
  );
}

/** The cost card's drill-down: the mock's Cloudflare modal, scoped to the one
 *  card that has a breakdown worth a second screen. */
function CostDetailDialog({
  cost,
  costRhythm,
  costSeriesByProject,
  projectsById,
  orgSlug,
}: {
  cost: MonthlyCost;
  costRhythm: readonly number[];
  costSeriesByProject: Map<string, readonly number[]>;
  projectsById: Map<string, VirtualMCPEntity>;
  orgSlug: string;
}) {
  const t = useT();
  return (
    <DialogContent className="sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>{t("home.stats.costLabel")}</DialogTitle>
        <DialogDescription>{t("home.stats.costWindow")}</DialogDescription>
      </DialogHeader>
      <section className="flex flex-col gap-4 rounded-xl border border-border p-4">
        <div className="flex items-baseline gap-2">
          <Figure value={formatUsd(cost.total)} />
          <TrendBadge delta={trendDelta(costRhythm)} format={formatUsd} />
        </div>
        <CostTrendChart
          costSeriesByProject={costSeriesByProject}
          projectsById={projectsById}
          days={costRhythm.length}
        />
      </section>
      <section className="flex flex-col gap-4 rounded-xl border border-border p-4">
        <h4 className="text-muted-foreground text-sm">
          {t("home.stats.topProjects")}
        </h4>
        <TopProjectsList
          byProject={cost.byProject}
          projectsById={projectsById}
          orgSlug={orgSlug}
        />
      </section>
    </DialogContent>
  );
}

export function BriefStats({
  cost,
  costRhythm,
  costSeriesByProject,
  runs,
  runsRhythm,
  automations,
  projectsById,
  orgSlug,
}: {
  cost: MonthlyCost;
  /** Dollars per day, oldest first — the cost card's bars. */
  costRhythm: readonly number[];
  /** Dollars per day per top spender — the drill-down's per-line data. */
  costSeriesByProject: Map<string, readonly number[]>;
  runs: RunsToday;
  /** Runs per day, oldest first. */
  runsRhythm: readonly number[];
  /** Null while the automation list is still loading — the card says nothing
   *  rather than claiming zero, which reads as "you have none". */
  automations: { running: number; paused: number } | null;
  projectsById: Map<string, VirtualMCPEntity>;
  orgSlug: string;
}) {
  const t = useT();
  const [costDialogOpen, setCostDialogOpen] = useState(false);

  return (
    <div className="@container mt-1">
      <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2 @4xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <Dialog open={costDialogOpen} onOpenChange={setCostDialogOpen}>
          <DialogTrigger asChild>
            <StatCard
              label={t("home.stats.costLabel")}
              className="@2xl:col-span-2 @4xl:col-span-1"
              interactive
              action={
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="size-6 p-0"
                      aria-label={t("home.stats.moreActions")}
                    >
                      <DotsVertical size={14} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setCostDialogOpen(true)}>
                      <BarChartSquare02 size={16} />
                      {t("home.stats.viewDetails")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              }
            >
              <div className="flex items-baseline gap-2">
                <Figure value={formatUsd(cost.total)} />
                <TrendBadge delta={trendDelta(costRhythm)} format={formatUsd} />
              </div>
              <RhythmChart
                series={costRhythm}
                formatValue={formatUsd}
                label={t("home.stats.costWindow")}
                height={96}
              />
              <span className="text-xs text-muted-foreground">
                {t("home.stats.costWindow")}
              </span>
            </StatCard>
          </DialogTrigger>
          <CostDetailDialog
            cost={cost}
            costRhythm={costRhythm}
            costSeriesByProject={costSeriesByProject}
            projectsById={projectsById}
            orgSlug={orgSlug}
          />
        </Dialog>

        <StatCard label={t("home.stats.runsLabel")}>
          <div className="flex items-baseline gap-2">
            <Figure
              value={String(runs.runs)}
              caption={
                runs.live > 0 ? (
                  <span className="inline-flex items-center gap-1.5 text-foreground">
                    <span className="relative flex size-1.5">
                      <span className="absolute inline-flex size-1.5 animate-ping rounded-full bg-brand opacity-70" />
                      <span className="relative inline-flex size-1.5 rounded-full bg-brand" />
                    </span>
                    {t("home.stats.liveNow", { count: runs.live })}
                  </span>
                ) : undefined
              }
            />
            <TrendBadge
              delta={trendDelta(runsRhythm)}
              format={(value) => String(Math.round(value))}
            />
          </div>
          <RhythmChart
            series={runsRhythm}
            label={t("home.stats.runsWindow", { days: runsRhythm.length })}
            height={96}
          />
          <span className="text-xs text-muted-foreground">
            {t("home.stats.runsWindow", { days: runsRhythm.length })}
          </span>
        </StatCard>

        {/* No link out: automations are per project, so there is no org-wide
            page this could open without picking one for you. */}
        <StatCard label={t("home.stats.automationsLabel")}>
          {automations ? (
            <>
              <div className="flex items-baseline gap-5">
                <Count
                  value={automations.running}
                  label={t("home.stats.running")}
                />
                <Count
                  value={automations.paused}
                  label={t("home.stats.paused")}
                  muted
                />
              </div>
              {automations.running + automations.paused === 0 ? (
                <p className="text-muted-foreground text-xs leading-5">
                  {t("home.stats.noAutomations")}
                </p>
              ) : null}
            </>
          ) : (
            <Figure value="\u2014" />
          )}
        </StatCard>
      </div>
    </div>
  );
}

/** The mock's `.autos`: the number over its word, not beside it. */
function Count({
  value,
  label,
  muted,
}: {
  value: number;
  label: string;
  muted?: boolean;
}) {
  return (
    <span className="flex flex-col gap-1.5">
      <span
        className={cn(
          "tnum text-3xl font-semibold leading-none",
          muted ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {value}
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </span>
  );
}
