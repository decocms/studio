/**
 * Renderers for the five analytics section shapes, in the Monitor's language.
 *
 * Section titles and column names come from the server verbatim (English, like
 * every other server-originated string); only the page chrome is translated.
 */

import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "@decocms/ui/components/chart.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@decocms/ui/components/table.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Calendar,
  Flag01,
  LayersThree01,
  Tag01,
  User01,
} from "@untitledui/icons";
import { ViewModeToggle } from "@decocms/ui/components/view-mode-toggle.tsx";
import { type ComponentType, type ReactNode, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts";
import type { AnalyticsSection } from "@/hooks/use-task-board-analytics";
import { useT } from "@/i18n/use-t";
import { useNavigate } from "@tanstack/react-router";
import { timeAgo } from "@/lib/format-time";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { SettingsSection } from "@/components/settings/settings-section";
import {
  PRIORITY_CONFIG,
  STATUS_CONFIG,
  TASK_TYPE_CONFIG,
  laneHeader,
} from "./config";

/** A task link that stays in the app; modified clicks still open a new tab. */
function TaskLink({
  href,
  className,
  children,
}: {
  href?: string;
  className?: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        if (!href || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey)
          return;
        e.preventDefault();
        navigate({ href });
      }}
    >
      {children}
    </a>
  );
}

type SectionOf<K extends AnalyticsSection["kind"]> = Extract<
  AnalyticsSection,
  { kind: K }
>;

/** A figure someone clicked, to list the cards behind it. */
export interface DrillTarget {
  drill: string;
  label: string;
}

type OnDrill = (target: DrillTarget) => void;

const drillHandler = (
  onDrill: OnDrill | undefined,
  drill: string | undefined,
  label: string,
) => (onDrill && drill ? () => onDrill({ drill, label }) : undefined);

/** Hover and focus for a card or row that opens the cards behind it. */
const CLICKABLE =
  "cursor-pointer text-left transition-colors hover:bg-accent/50 focus-ring";

/** Fixed order, never cycled — a series keeps its hue as the set changes. */
const SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

const AXIS_TICK = {
  fontSize: 11,
  fill: "var(--muted-foreground)",
  opacity: 0.7,
};

/** Seconds read as durations; a raw 604800 is not an answer to "how long". */
function formatDuration(seconds: number): string {
  const abs = Math.abs(seconds);
  if (abs < 60) return `${Math.round(seconds)}s`;
  if (abs < 3600) return `${Math.round(seconds / 60)}m`;
  if (abs < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

function formatValue(value: number | null, unit?: string): string {
  if (value === null || Number.isNaN(value)) return "—";
  if (unit === "s") return formatDuration(value);
  if (unit === "%") return `${Math.round(value * 10) / 10}%`;
  if (unit === "USD") return `$${value.toFixed(2)}`;
  return value.toLocaleString();
}

function formatAxis(value: number, unit?: string): string {
  if (unit === "s") return formatDuration(value);
  if (unit === "%") return `${value}%`;
  if (unit === "USD") return `$${value}`;
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function formatCell(value: string | number, unit?: string): string {
  if (typeof value === "number") return formatValue(value, unit);
  if (ISO_DATE.test(value)) {
    return new Date(`${value}T12:00:00Z`).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }
  return ISO_TIMESTAMP.test(value) ? timeAgo(value) : value;
}

/** The Monitor's metric card: a quiet title, one figure, then the detail. */
function MetricCard({
  title,
  value,
  caption,
  aside,
  children,
  onClick,
}: {
  title: string;
  value?: ReactNode;
  caption?: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
  onClick?: () => void;
}) {
  const Root = onClick ? "button" : "section";
  return (
    <Root
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={cn(
        "surface flex h-full w-full flex-col gap-6 px-4 pt-4 pb-5",
        onClick && CLICKABLE,
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-sm text-foreground/70">{title}</h3>
          {value !== undefined && (
            <span className="tnum text-4xl font-normal text-foreground">
              {value}
            </span>
          )}
          {caption}
        </div>
        {aside}
      </div>
      {children}
    </Root>
  );
}

/** A lane as the board draws it: its icon and name. */
function LaneBadge({ lane }: { lane: string }) {
  const t = useT();
  const { label, visual } = laneHeader(lane, t);
  const Icon = visual.icon;
  return (
    <Badge variant="muted">
      <Icon className={visual.iconClassName} />
      {label}
    </Badge>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-20 items-center justify-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/** Up or down against the previous window, coloured by whether that is good. */
function Delta({
  value,
  previous,
  unit,
  better,
}: {
  value: number | null;
  previous: number | null | undefined;
  unit?: string;
  better?: "up" | "down";
}) {
  const t = useT();
  if (value === null || previous === null || previous === undefined) {
    return (
      <span className="text-meta">{t("taskBoard.analytics.noPrior")}</span>
    );
  }
  const diff = Math.round((value - previous) * 10) / 10;
  const improved = better === "down" ? diff < 0 : diff > 0;
  const amount =
    unit === "%"
      ? t("taskBoard.analytics.points", { n: String(Math.abs(diff)) })
      : formatValue(Math.abs(diff), unit);
  return (
    <span className="text-meta inline-flex items-center gap-1">
      {diff === 0 ? (
        t("taskBoard.analytics.unchanged")
      ) : (
        <span
          className={cn(
            "inline-flex items-center gap-0.5 font-medium",
            better && (improved ? "text-success" : "text-destructive"),
          )}
        >
          {diff > 0 ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
          {amount}
        </span>
      )}
      <span>{t("taskBoard.analytics.vsPrevious")}</span>
    </span>
  );
}

/** Rows that come out even: six stats read as two threes, not a four and a two. */
const STAT_COLUMNS: Record<number, string> = {
  1: "lg:grid-cols-1",
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  5: "lg:grid-cols-5",
  6: "lg:grid-cols-3",
  9: "lg:grid-cols-3",
};

function StatCards({
  section,
  onDrill,
}: {
  section: SectionOf<"stat">;
  onDrill?: OnDrill;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-4",
        STAT_COLUMNS[section.values.length] ?? "lg:grid-cols-4",
      )}
    >
      {section.values.map((v) => (
        <MetricCard
          key={v.label}
          title={v.label}
          value={formatValue(v.value, v.unit)}
          onClick={drillHandler(onDrill, v.drill, v.label)}
          caption={
            <>
              {v.detail && (
                <span className="text-sm text-muted-foreground">
                  {v.detail}
                </span>
              )}
              {v.previous !== undefined && (
                <Delta
                  value={v.value}
                  previous={v.previous}
                  unit={v.unit}
                  better={v.better}
                />
              )}
            </>
          }
        />
      ))}
    </div>
  );
}

/**
 * Sorted, not insertion-order: insertion order tracks which point happens to
 * carry a key first, so it drifts as the date range changes and a series
 * would swap hues between visits — sorting keys by name keeps a series' hue
 * fixed regardless of which points are in view.
 */
export function seriesKeys(
  points: readonly Record<string, unknown>[],
): string[] {
  return Array.from(new Set(points.flatMap((p) => Object.keys(p))))
    .filter((k) => k !== "t")
    .sort();
}

/** Drops series that never leave zero — unless every series is, and then the
 *  flat line IS the answer. */
function visibleKeys(
  points: readonly Record<string, unknown>[],
  keys: string[],
): string[] {
  const live = keys.filter((k) =>
    points.some((p) => typeof p[k] === "number" && p[k] !== 0),
  );
  return live.length > 0 ? live : keys;
}

/**
 * Per-day counts arrive only for days that had any, so bars would sit shoulder
 * to shoulder across gaps and a single day would look like the whole range.
 * Every day of the range gets a slot; the missing ones are zero.
 */
export function fillDays(
  points: readonly Record<string, string | number | null>[],
  keys: readonly string[],
  range: { from: string; to: string },
): Record<string, string | number | null>[] {
  const byDay = new Map(points.map((p) => [String(p.t ?? "").slice(0, 10), p]));
  const day = new Date(`${range.from.slice(0, 10)}T00:00:00.000Z`);
  const last = range.to.slice(0, 10);
  const filled: Record<string, string | number | null>[] = [];
  while (day.toISOString().slice(0, 10) <= last) {
    const key = day.toISOString().slice(0, 10);
    filled.push(
      byDay.get(key) ?? {
        t: day.toISOString(),
        ...Object.fromEntries(keys.map((k) => [k, 0])),
      },
    );
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return filled;
}

function SeriesTooltip({
  active,
  payload,
  unit,
  nameOf = String,
}: {
  active?: boolean;
  payload?: {
    dataKey?: unknown;
    value?: unknown;
    color?: string;
    payload?: { t?: unknown; label?: unknown };
  }[];
  unit?: string;
  /** A series' display name, when its key is not one (a lane key). */
  nameOf?: (key: string) => string;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  const t = row?.t;
  return (
    <div className="rounded-lg border bg-background px-3 py-2 shadow-md">
      <div className="mb-1 text-xs text-muted-foreground">
        {typeof t === "string"
          ? new Date(t).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })
          : String(row?.label ?? "")}
      </div>
      <div className="flex flex-col gap-1">
        {payload.map((item) => (
          <div
            key={String(item.dataKey)}
            className="flex items-center gap-1.5 text-xs"
          >
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: item.color }}
            />
            <span className="text-muted-foreground">
              {nameOf(String(item.dataKey))}
            </span>
            <span className="tnum ml-auto pl-3 font-medium">
              {formatValue(
                typeof item.value === "number" ? item.value : null,
                unit,
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Counts and money per day are bars, stacked when there are several — a day
 * with nothing is a gap, not a line drawn through it. Rates and durations
 * are areas: they are levels, and the line between two days means something.
 */
function SeriesCard({
  section,
  range,
}: {
  section: SectionOf<"series">;
  range?: { from: string; to: string };
}) {
  const t = useT();
  const unit = section.unit ?? undefined;
  const asBars = unit !== "%" && unit !== "s";
  const allKeys = seriesKeys(section.points);
  // A rate at 0% is news; a count stuck at 0 is an unused feature.
  const keys = asBars ? visibleKeys(section.points, allKeys) : allKeys;
  const color = (k: string) =>
    SERIES_COLORS[allKeys.indexOf(k) % SERIES_COLORS.length];
  const config: ChartConfig = Object.fromEntries(
    keys.map((k) => [k, { label: k, color: color(k) }]),
  );
  const points =
    asBars && range ? fillDays(section.points, allKeys, range) : section.points;
  const data = points.map((p) => ({
    ...p,
    label: new Date(String(p.t ?? "")).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    }),
  }));
  const gradientId = `analytics-${section.title.replace(/\W+/g, "-")}`;

  const grid = (
    <CartesianGrid
      strokeDasharray="4 4"
      stroke="var(--border)"
      strokeOpacity={0.5}
      vertical={false}
    />
  );
  const xAxis = (
    <XAxis
      dataKey="label"
      axisLine={false}
      tickLine={false}
      tick={AXIS_TICK}
      minTickGap={24}
      tickMargin={8}
    />
  );
  const yAxis = (
    <YAxis
      orientation="right"
      axisLine={false}
      tickLine={false}
      tick={AXIS_TICK}
      domain={unit === "%" ? [0, 100] : [0, "auto"]}
      allowDecimals={unit !== undefined}
      tickFormatter={(v: number) => formatAxis(v, unit)}
      width={48}
      tickCount={5}
    />
  );
  const tooltip = (
    <ChartTooltip
      cursor={
        asBars
          ? { fill: "var(--muted)", opacity: 0.4 }
          : { stroke: "var(--border)", strokeDasharray: "4 4" }
      }
      content={({ active, payload }) => (
        <SeriesTooltip active={active} payload={payload} unit={unit} />
      )}
    />
  );

  return (
    <MetricCard
      title={section.title}
      aside={
        keys.length > 1 && (
          <ul className="flex flex-wrap justify-end gap-x-3 gap-y-1">
            {keys.map((k) => (
              <li key={k} className="text-meta flex items-center gap-1.5">
                <span
                  className="size-2 rounded-full"
                  style={{ backgroundColor: color(k) }}
                />
                {k}
              </li>
            ))}
          </ul>
        )
      }
    >
      {data.length === 0 ? (
        <Empty>{t("taskBoard.analytics.noDataInRange")}</Empty>
      ) : (
        <ChartContainer
          role="img"
          aria-label={section.title}
          className="h-[140px] w-full md:h-[180px]"
          config={config}
        >
          {asBars ? (
            <BarChart data={data} margin={{ left: 0, right: 0, top: 8 }}>
              {grid}
              {xAxis}
              {yAxis}
              {tooltip}
              {keys.map((k, i) => (
                <Bar
                  key={k}
                  dataKey={k}
                  stackId="day"
                  fill={color(k)}
                  maxBarSize={24}
                  radius={i === keys.length - 1 ? [4, 4, 0, 0] : 0}
                  animationDuration={300}
                />
              ))}
            </BarChart>
          ) : (
            <AreaChart data={data} margin={{ left: 0, right: 0, top: 8 }}>
              {keys.length === 1 && (
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="0%"
                      stopColor={color(keys[0] ?? "")}
                      stopOpacity={0.2}
                    />
                    <stop
                      offset="100%"
                      stopColor={color(keys[0] ?? "")}
                      stopOpacity={0}
                    />
                  </linearGradient>
                </defs>
              )}
              {grid}
              {xAxis}
              {yAxis}
              {tooltip}
              {keys.map((k) => (
                <Area
                  key={k}
                  type="linear"
                  dataKey={k}
                  stroke={color(k)}
                  strokeWidth={2}
                  fill={keys.length === 1 ? `url(#${gradientId})` : "none"}
                  dot={data.length === 1 ? { r: 4 } : false}
                  activeDot={{
                    r: 4,
                    stroke: "var(--background)",
                    strokeWidth: 2,
                  }}
                  connectNulls
                  animationDuration={300}
                />
              ))}
            </AreaChart>
          )}
        </ChartContainer>
      )}
    </MetricCard>
  );
}

/**
 * The Monitor's leaderboard row, with the share drawn as a thin bar in its own
 * column so the figures line up and never sit on the fill.
 */
function RankRow({
  label,
  note,
  share,
  value,
  fill,
  color,
  onClick,
}: {
  label: string;
  note?: string;
  share?: string;
  value: string;
  fill: number;
  color: string;
  onClick?: () => void;
}) {
  const Row = onClick ? "button" : "div";
  return (
    <li className="border-b border-border/50 last:border-b-0">
      <Row
        type={onClick ? "button" : undefined}
        onClick={onClick}
        className={cn(
          "flex h-10 w-full items-center gap-3",
          onClick && cn(CLICKABLE, "-mx-2 w-[calc(100%+1rem)] rounded-md px-2"),
        )}
      >
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
          {label}
          {note && <span className="text-meta ml-2">{note}</span>}
        </span>
        <span className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-muted">
          <span
            className="block h-full rounded-full"
            style={{
              width: `${Math.max(0, Math.min(100, fill))}%`,
              backgroundColor: color,
            }}
          />
        </span>
        {share !== undefined && (
          <span className="tnum w-16 shrink-0 text-right text-sm text-foreground/40">
            {share}
          </span>
        )}
        <span className="tnum w-8 shrink-0 text-right text-sm text-foreground">
          {value}
        </span>
      </Row>
    </li>
  );
}

/** Each stage against the first; the figure is how many made it all the way. */
function FunnelCard({
  section,
  onDrill,
}: {
  section: SectionOf<"funnel">;
  onDrill?: OnDrill;
}) {
  const t = useT();
  const start = section.stages[0]?.value ?? 0;
  const end = section.stages.at(-1)?.value ?? 0;
  return (
    <MetricCard
      title={section.title}
      value={start ? `${Math.round((100 * end) / start)}%` : "—"}
      caption={
        start > 0 && (
          <span className="text-meta">
            {t("taskBoard.analytics.funnelCaption", {
              end: String(end),
              start: String(start),
            })}
          </span>
        )
      }
    >
      {start === 0 ? (
        <Empty>{t("taskBoard.analytics.noDataInRange")}</Empty>
      ) : (
        <ol className="flex flex-col">
          {section.stages.map((stage, i) => {
            const prev = section.stages[i - 1]?.value;
            const lost = prev === undefined ? 0 : prev - stage.value;
            return (
              <RankRow
                key={stage.label}
                label={stage.label}
                note={
                  lost > 0
                    ? t("taskBoard.analytics.dropped", { n: String(lost) })
                    : undefined
                }
                share={`${Math.round((100 * stage.value) / start)}%`}
                value={stage.value.toLocaleString()}
                fill={(100 * stage.value) / start}
                color="var(--chart-2)"
                onClick={drillHandler(onDrill, stage.drill, stage.label)}
              />
            );
          })}
        </ol>
      )}
    </MetricCard>
  );
}

function BarsCard({
  section,
  onDrill,
}: {
  section: SectionOf<"bars">;
  onDrill?: OnDrill;
}) {
  const t = useT();
  const max = Math.max(0, ...section.bars.map((b) => b.value));
  return (
    <MetricCard
      title={section.title}
      value={section.total?.value.toLocaleString()}
      caption={
        section.total && (
          <span className="text-meta">{section.total.label}</span>
        )
      }
      aside={section.unit && <span className="text-meta">{section.unit}</span>}
    >
      {section.bars.length === 0 ? (
        <Empty>{t("taskBoard.analytics.nobodyStepped")}</Empty>
      ) : (
        <ul className="flex flex-col">
          {section.bars.map((bar) => (
            <RankRow
              key={bar.label}
              label={bar.label}
              note={bar.note}
              share={bar.detail}
              value={bar.value.toLocaleString()}
              fill={max ? (100 * bar.value) / max : 0}
              color="var(--chart-1)"
              onClick={drillHandler(onDrill, bar.drill, bar.label)}
            />
          ))}
        </ul>
      )}
    </MetricCard>
  );
}

/** `/$org/$taskId` is the forever-supported way into any org's thread. */
function threadHref(org: string, threadId: string): string {
  return `/${encodeURIComponent(org)}/${encodeURIComponent(threadId)}`;
}

/** Ids that only exist to be joined on — never a thing a reader reads. */
const HIDDEN_COLUMNS = new Set(["Org ID", "Task ID"]);

/** Short classifiers, read as tags rather than prose. */
const TAG_COLUMNS = new Set([
  "Run outcome",
  "Failure kind",
  "Moved in by",
  "State",
]);

/** Machine text: kept verbatim, set apart from the sentence-like columns. */
const CODE_COLUMNS = new Set(["Error", "Signature"]);

/** Columns that only say something across tenants. */
const CROSS_ORG_COLUMNS = new Set(["Org", "Orgs"]);

function TableCard({
  section,
  threadLinks,
  showOrg,
  taskHref,
  onDrill,
}: {
  section: SectionOf<"table">;
  threadLinks?: boolean;
  showOrg?: boolean;
  taskHref?: (taskId: string) => string;
  onDrill?: OnDrill;
}) {
  const t = useT();
  const orgCol = section.columns.indexOf("Org");
  const threadCol =
    threadLinks && orgCol >= 0 ? section.columns.indexOf("Thread") : -1;
  const taskIdCol = section.columns.indexOf("Task ID");
  const taskCol =
    taskHref && taskIdCol >= 0 ? section.columns.indexOf("Task") : -1;
  const shown = section.columns
    .map((c, j) => ({ c, j }))
    .filter(
      ({ c }) =>
        !HIDDEN_COLUMNS.has(c) &&
        (showOrg !== false || !CROSS_ORG_COLUMNS.has(c)),
    )
    // The task is what a row is about; its lane reads as a label beside it.
    .sort((a, b) => Number(b.c === "Task") - Number(a.c === "Task"));
  // Figures line up on the right, where their digits compare.
  const numeric = new Set(
    shown
      .filter(({ j }) => {
        const values = section.rows.map((r) => r[j]).filter((v) => v !== null);
        return values.length > 0 && values.every((v) => typeof v === "number");
      })
      .map(({ c }) => c),
  );
  // One row of figures is a scorecard, not a table: label over value.
  if (section.rows.length === 1 && shown.every(({ c }) => numeric.has(c))) {
    const row = section.rows[0] ?? [];
    return (
      <SettingsSection title={section.title}>
        <dl className="surface grid px-4 pt-4 pb-5 grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-[repeat(auto-fill,minmax(120px,1fr))]">
          {shown.map(({ c, j }) => {
            const value = row[j];
            return (
              <div key={c} className="flex flex-col gap-1">
                <dt className="text-meta">{c}</dt>
                <dd className="tnum text-2xl text-foreground">
                  {typeof value === "number"
                    ? formatValue(value, section.units?.[c])
                    : "—"}
                </dd>
              </div>
            );
          })}
        </dl>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title={section.title}>
      {section.rows.length === 0 ? (
        <p className="surface px-4 py-4 text-sm text-muted-foreground">
          {t("taskBoard.analytics.nothingToShow")}
        </p>
      ) : (
        <div className="surface max-h-[480px] overflow-auto">
          <Table variant="flush">
            <TableHeader>
              <TableRow>
                {shown.map(({ c }) => (
                  <TableHead
                    key={c}
                    className={cn(
                      "whitespace-nowrap first:pl-4 last:pr-4",
                      numeric.has(c) && "text-right",
                    )}
                  >
                    {c === "Thread" ? "" : c}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {section.rows.map((row, i) => (
                <TableRow key={`${section.title}-${i}`}>
                  {shown.map(({ c, j }, k) => {
                    const value = row[j];
                    const taskId = taskCol === j ? row[taskIdCol] : null;
                    const drill =
                      k === 0
                        ? drillHandler(
                            onDrill,
                            section.drills?.[i] ?? undefined,
                            String(value ?? ""),
                          )
                        : undefined;
                    return (
                      <TableCell
                        key={c}
                        className={cn(
                          "max-w-md truncate text-sm first:pl-4 last:pr-4",
                          numeric.has(c) && "text-right",
                        )}
                      >
                        {value === null || value === undefined ? (
                          <span className="text-muted-foreground">—</span>
                        ) : j === threadCol ? (
                          <a
                            href={threadHref(
                              String(row[orgCol]),
                              String(value),
                            )}
                            target="_blank"
                            rel="noreferrer"
                            className="focus-ring inline-flex items-center gap-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                          >
                            {t("taskBoard.analytics.openChat")}
                            <ArrowUpRight size={12} />
                          </a>
                        ) : drill ? (
                          <button
                            type="button"
                            onClick={drill}
                            className="focus-ring text-left text-foreground underline-offset-2 hover:underline"
                          >
                            {String(value)}
                          </button>
                        ) : taskId ? (
                          <TaskLink
                            href={taskHref?.(String(taskId))}
                            className="focus-ring text-foreground underline-offset-2 hover:underline"
                          >
                            {String(value)}
                          </TaskLink>
                        ) : c === "Lane" && typeof value === "string" ? (
                          <LaneBadge lane={value} />
                        ) : c === "Priority" && typeof value === "string" ? (
                          <span className="flex items-center gap-2">
                            <GroupIcon
                              drill={`priority:${value.toLowerCase()}`}
                            />
                            {value}
                          </span>
                        ) : TAG_COLUMNS.has(c) ? (
                          <Badge variant="muted">{String(value)}</Badge>
                        ) : CODE_COLUMNS.has(c) ? (
                          <span
                            title={String(value)}
                            className="font-mono text-xs text-muted-foreground"
                          >
                            {String(value)}
                          </span>
                        ) : (
                          <span
                            className={cn(
                              "tnum",
                              typeof value === "string" &&
                                ISO_TIMESTAMP.test(value) &&
                                "text-muted-foreground",
                            )}
                          >
                            {formatCell(value, section.units?.[c])}
                          </span>
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </SettingsSection>
  );
}

/** The cards behind a figure, from `TASK_BOARD_OPERATION_TASKS`'s table. */
export function DrillList({
  section,
  taskHref,
}: {
  section: SectionOf<"table">;
  taskHref?: (taskId: string) => string;
}) {
  const t = useT();
  const col = (name: string) => section.columns.indexOf(name);
  if (section.rows.length === 0) {
    return <Empty>{t("taskBoard.analytics.nothingToShow")}</Empty>;
  }
  return (
    <ul className="flex flex-col">
      {section.rows.map((row) => {
        const id = String(row[col("Task ID")] ?? "");
        const lane = row[col("Lane")];
        const started = row[col("Picked up")];
        const actions = Number(row[col("Actions by people")] ?? 0);
        const qaFailures = Number(row[col("Failed QA")] ?? 0);
        const meta = [
          typeof started === "string" ? timeAgo(started) : null,
          actions > 0 &&
            t(
              actions === 1
                ? "taskBoard.analytics.humanActionsOne"
                : "taskBoard.analytics.humanActions",
              { n: String(actions) },
            ),
        ].filter(Boolean);
        const body = (
          <>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-sm text-foreground">
                {String(row[col("Task")] ?? "")}
              </span>
              <span className="text-meta truncate">{meta.join(" · ")}</span>
            </span>
            {qaFailures > 0 && (
              <Badge variant="muted">
                <AlertCircle className="text-destructive" />
                {qaFailures === 1
                  ? t("taskBoard.analytics.failedQa")
                  : t("taskBoard.analytics.failedQaTimes", {
                      n: String(qaFailures),
                    })}
              </Badge>
            )}
            {typeof lane === "string" && <LaneBadge lane={lane} />}
          </>
        );
        return (
          <li key={id} className="border-b border-border/50 last:border-b-0">
            {taskHref ? (
              <TaskLink
                href={taskHref(id)}
                className={cn(
                  CLICKABLE,
                  "flex items-center gap-3 rounded-md p-2",
                )}
              >
                {body}
              </TaskLink>
            ) : (
              <div className="flex items-center gap-3 p-2">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

type Metric = SectionOf<"breakdown">["metrics"][number];

const DIMENSION_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  Type: LayersThree01,
  Priority: Flag01,
  Tag: Tag01,
  Sprint: Calendar,
  "Brief by": User01,
};

/** The board's own glyph for a group that is a type or a priority. */
function GroupIcon({ drill }: { drill?: string }) {
  const [field, value] = (drill ?? "").split("&")[0]?.split(":") ?? [];
  const known =
    field === "type"
      ? Object.entries(TASK_TYPE_CONFIG).find(([k]) => k === value)?.[1]
      : field === "priority"
        ? Object.entries(PRIORITY_CONFIG).find(([k]) => k === value)?.[1]
        : undefined;
  if (!known) return null;
  const Icon = known.icon;
  return <Icon className={cn("size-3.5 shrink-0", known.iconClassName)} />;
}

/** A rate as a short bar and its figure, so a column of them compares at a glance. */
function RateCell({
  value,
  metric,
  color,
}: {
  value: number | null | undefined;
  metric: Metric;
  color: string;
}) {
  const fill = value === null || value === undefined ? 0 : value;
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full"
          style={{
            width: `${metric.unit === "%" ? Math.min(100, fill) : 0}%`,
            backgroundColor: color,
          }}
        />
      </span>
      <span className="tnum w-12 shrink-0 text-right text-sm text-foreground">
        {formatValue(value ?? null, metric.unit)}
      </span>
    </span>
  );
}

/** The same groups' rates, cut one way at a time. */
function BreakdownCard({
  section,
  onDrill,
}: {
  section: SectionOf<"breakdown">;
  onDrill?: OnDrill;
}) {
  const t = useT();
  const [cut, setCut] = useState(section.dimensions[0]?.label ?? "");
  const current =
    section.dimensions.find((d) => d.label === cut) ?? section.dimensions[0];
  const columns = `minmax(0,1fr) 56px repeat(${section.metrics.length}, minmax(96px, 168px))`;
  return (
    <MetricCard
      title={section.title}
      aside={
        section.dimensions.length > 1 && (
          <ViewModeToggle
            value={current?.label ?? ""}
            onValueChange={setCut}
            options={section.dimensions.map((d) => {
              const Icon = DIMENSION_ICONS[d.label];
              return {
                value: d.label,
                label: d.label,
                icon: Icon ? <Icon /> : undefined,
              };
            })}
          />
        )
      }
    >
      {!current || current.rows.length === 0 ? (
        <Empty>{t("taskBoard.analytics.noDataInRange")}</Empty>
      ) : (
        <div className="flex flex-col">
          <div
            className="text-meta grid items-center gap-4 border-b border-border/50 pb-2"
            style={{ gridTemplateColumns: columns }}
          >
            <span>{current.label}</span>
            <span className="text-right">{t("taskBoard.analytics.tasks")}</span>
            {section.metrics.map((m) => (
              <span key={m.key} className="text-right">
                {m.label}
              </span>
            ))}
          </div>
          {current.rows.map((row) => {
            const open = drillHandler(onDrill, row.drill, row.label);
            const Row = open ? "button" : "div";
            return (
              <Row
                key={row.label}
                type={open ? "button" : undefined}
                onClick={open}
                className={cn(
                  "grid h-11 items-center gap-4 border-b border-border/50 last:border-b-0",
                  open &&
                    cn(CLICKABLE, "-mx-2 w-[calc(100%+1rem)] rounded-md px-2"),
                )}
                style={{ gridTemplateColumns: columns }}
              >
                <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                  <GroupIcon drill={row.drill} />
                  <span className="truncate">{row.label}</span>
                </span>
                <span className="tnum text-right text-sm text-muted-foreground">
                  {row.count.toLocaleString()}
                </span>
                {section.metrics.map((m) => (
                  <RateCell
                    key={m.key}
                    value={row.values[m.key]}
                    metric={m}
                    color={
                      m.better === "up"
                        ? "var(--success)"
                        : "var(--destructive)"
                    }
                  />
                ))}
              </Row>
            );
          })}
        </div>
      )}
    </MetricCard>
  );
}

/** Below this many cards a cell's rate is an anecdote, so it reads faded. */
const MATRIX_MIN_CARDS = 3;

/** Two cuts crossed: each cell tinted by how bad (or good) its rate is. */
function MatrixCard({
  section,
  onDrill,
}: {
  section: SectionOf<"matrix">;
  onDrill?: OnDrill;
}) {
  const t = useT();
  const [metricKey, setMetricKey] = useState(section.metrics[0]?.key ?? "");
  const metric =
    section.metrics.find((m) => m.key === metricKey) ?? section.metrics[0];
  if (!metric) return null;
  const tint = metric.better === "up" ? "var(--success)" : "var(--destructive)";
  const symmetric =
    section.rows.length === section.cols.length &&
    section.rows.every((r, i) => section.cols[i] === r);
  const columns = `minmax(96px, 1fr) repeat(${section.cols.length}, minmax(72px, 1fr))`;
  return (
    <MetricCard
      title={section.title}
      caption={
        <span className="text-meta">
          {t("taskBoard.analytics.matrixCaption", {
            n: String(MATRIX_MIN_CARDS),
          })}
        </span>
      }
      aside={
        section.metrics.length > 1 && (
          <ViewModeToggle
            value={metric.key}
            onValueChange={setMetricKey}
            options={section.metrics.map((m) => ({
              value: m.key,
              label: m.label,
            }))}
          />
        )
      }
    >
      {section.rows.length === 0 ? (
        <Empty>{t("taskBoard.analytics.noDataInRange")}</Empty>
      ) : (
        <div className="overflow-x-auto">
          <div
            className="grid min-w-fit gap-1"
            style={{ gridTemplateColumns: columns }}
          >
            <span className="text-meta self-end pb-1">
              {section.rowLabel} / {section.colLabel}
            </span>
            {section.cols.map((col) => (
              <span key={col} className="text-meta self-end pb-1 text-center">
                {col}
              </span>
            ))}
            {section.rows.map((row, i) => (
              <MatrixRow
                key={row}
                row={row}
                section={section}
                metric={metric}
                tint={tint}
                onDrill={onDrill}
                // A dimension crossed with itself mirrors; show one half.
                upTo={symmetric ? i : undefined}
              />
            ))}
          </div>
        </div>
      )}
    </MetricCard>
  );
}

function MatrixRow({
  row,
  section,
  metric,
  tint,
  onDrill,
  upTo,
}: {
  row: string;
  section: SectionOf<"matrix">;
  metric: Metric;
  tint: string;
  onDrill?: OnDrill;
  /** Draw only the columns up to this index. */
  upTo?: number;
}) {
  const t = useT();
  return (
    <>
      <span className="flex items-center truncate pr-2 text-sm text-foreground">
        {row}
      </span>
      {section.cols.map((col, j) => {
        if (upTo !== undefined && j > upTo) return <span key={col} />;
        const cell = section.cells.find((c) => c.row === row && c.col === col);
        const value = cell?.values[metric.key] ?? null;
        if (!cell) {
          return (
            <span
              key={col}
              className="flex h-14 items-center justify-center rounded-md bg-muted/40 text-sm text-muted-foreground"
            >
              —
            </span>
          );
        }
        const strength =
          value === null ? 0 : Math.min(100, metric.unit === "%" ? value : 0);
        const open = drillHandler(
          onDrill,
          cell.drill,
          row === col ? row : `${row} · ${col}`,
        );
        return (
          <button
            key={col}
            type="button"
            onClick={open}
            disabled={!open}
            className={cn(
              "flex h-14 flex-col items-center justify-center rounded-md transition-opacity focus-ring",
              open && "cursor-pointer hover:opacity-80",
              cell.count < MATRIX_MIN_CARDS && "opacity-50",
            )}
            style={{
              backgroundColor: `color-mix(in oklch, ${tint} ${Math.round(8 + strength * 0.5)}%, var(--muted))`,
            }}
          >
            <span className="tnum text-sm font-medium text-foreground">
              {formatValue(value, metric.unit)}
            </span>
            <span className="text-meta">
              {cell.count === 1
                ? t("taskBoard.analytics.drillCountOne")
                : t("taskBoard.analytics.drillCount", {
                    n: String(cell.count),
                  })}
            </span>
          </button>
        );
      })}
    </>
  );
}

/** A series name: a lane key reads as the board's lane. */
function useSeriesName() {
  const t = useT();
  return (key: string) =>
    Object.hasOwn(STATUS_CONFIG, key) ? laneHeader(key, t).label : key;
}

/** Bars per category: a whole split into parts, or figures side by side. */
function CategoriesCard({
  section,
  onDrill,
}: {
  section: SectionOf<"categories">;
  onDrill?: OnDrill;
}) {
  const t = useT();
  const nameOf = useSeriesName();
  const unit = section.unit ?? undefined;
  const stacked = section.layout === "stacked";
  const measured = section.keys.filter((k) => k !== section.baseline);
  const color = (k: string) =>
    k === section.baseline
      ? "var(--border)"
      : (SERIES_COLORS[measured.indexOf(k) % SERIES_COLORS.length] ?? "");
  const config: ChartConfig = Object.fromEntries(
    section.keys.map((k) => [k, { label: nameOf(k), color: color(k) }]),
  );
  const data = section.categories.map((c) => ({ label: c.label, ...c.values }));
  const open = (index: number) => {
    const category = section.categories[index];
    if (category) drillHandler(onDrill, category.drill, category.label)?.();
  };
  const clickable = section.categories.some((c) => c.drill) && !!onDrill;
  const height = stacked
    ? Math.max(120, section.categories.length * 44 + 32)
    : 220;
  const tooltip = (
    <ChartTooltip
      cursor={{ fill: "var(--muted)", opacity: 0.4 }}
      content={({ active, payload }) => (
        <SeriesTooltip
          active={active}
          payload={payload}
          unit={unit}
          nameOf={nameOf}
        />
      )}
    />
  );

  return (
    <MetricCard
      title={section.title}
      aside={
        <ul className="flex flex-wrap justify-end gap-x-3 gap-y-1">
          {section.keys.map((k) => (
            <li key={k} className="text-meta flex items-center gap-1.5">
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: color(k) }}
              />
              {nameOf(k)}
            </li>
          ))}
        </ul>
      }
    >
      {data.length === 0 ? (
        <Empty>{t("taskBoard.analytics.noDataInRange")}</Empty>
      ) : (
        <ChartContainer
          role="img"
          aria-label={section.title}
          className="w-full"
          style={{ height }}
          config={config}
        >
          {stacked ? (
            <BarChart
              data={data}
              layout="vertical"
              margin={{ left: 0, right: 8, top: 0 }}
            >
              <CartesianGrid
                strokeDasharray="4 4"
                stroke="var(--border)"
                strokeOpacity={0.5}
                horizontal={false}
              />
              <XAxis
                type="number"
                axisLine={false}
                tickLine={false}
                tick={AXIS_TICK}
                tickFormatter={(v: number) => formatAxis(v, unit)}
              />
              <YAxis
                type="category"
                dataKey="label"
                axisLine={false}
                tickLine={false}
                tick={AXIS_TICK}
                width={72}
              />
              {tooltip}
              {section.keys.map((k, i) => (
                <Bar
                  key={k}
                  dataKey={k}
                  stackId="all"
                  fill={color(k)}
                  maxBarSize={22}
                  radius={i === section.keys.length - 1 ? [0, 4, 4, 0] : 0}
                  animationDuration={300}
                />
              ))}
            </BarChart>
          ) : (
            <BarChart
              data={data}
              margin={{ left: 0, right: 0, top: 8 }}
              barGap={4}
              barCategoryGap="28%"
            >
              <CartesianGrid
                strokeDasharray="4 4"
                stroke="var(--border)"
                strokeOpacity={0.5}
                vertical={false}
              />
              <XAxis
                dataKey="label"
                axisLine={false}
                tickLine={false}
                tick={AXIS_TICK}
                tickMargin={8}
              />
              <YAxis
                orientation="right"
                axisLine={false}
                tickLine={false}
                tick={AXIS_TICK}
                allowDecimals={unit !== undefined}
                tickFormatter={(v: number) => formatAxis(v, unit)}
                width={48}
              />
              {tooltip}
              {section.keys.map((k) => (
                <Bar
                  key={k}
                  dataKey={k}
                  fill={color(k)}
                  maxBarSize={32}
                  radius={[4, 4, 0, 0]}
                  animationDuration={300}
                  className={cn(clickable && "cursor-pointer")}
                  onClick={(_, index) => open(index)}
                />
              ))}
            </BarChart>
          )}
        </ChartContainer>
      )}
    </MetricCard>
  );
}

/** Rankings read at half width; everything else wants the row. */
export function sectionSpan(section: AnalyticsSection): "half" | "full" {
  return section.kind === "funnel" || section.kind === "bars" ? "half" : "full";
}

export function SectionView({
  section,
  threadLinks,
  showOrg,
  taskHref,
  range,
  onDrill,
}: {
  section: AnalyticsSection;
  /** The window the data covers, so per-day bars get a slot for every day. */
  range?: { from: string; to: string };
  /** Render a "Thread" column as a link into its row's "Org". */
  threadLinks?: boolean;
  /** Show cross-tenant columns; off when the page is about one org. */
  showOrg?: boolean;
  /** Make a "Task" column link to its row's "Task ID". */
  taskHref?: (taskId: string) => string;
  /** Open the cards behind a figure that carries a `drill`. */
  onDrill?: OnDrill;
}) {
  switch (section.kind) {
    case "stat":
      return <StatCards section={section} onDrill={onDrill} />;
    case "series":
      return <SeriesCard section={section} range={range} />;
    case "funnel":
      return <FunnelCard section={section} onDrill={onDrill} />;
    case "bars":
      return <BarsCard section={section} onDrill={onDrill} />;
    case "breakdown":
      return <BreakdownCard section={section} onDrill={onDrill} />;
    case "matrix":
      return <MatrixCard section={section} onDrill={onDrill} />;
    case "categories":
      return <CategoriesCard section={section} onDrill={onDrill} />;
    case "table":
      return (
        <TableCard
          section={section}
          threadLinks={threadLinks}
          showOrg={showOrg}
          taskHref={taskHref}
          onDrill={onDrill}
        />
      );
    default: {
      const unhandled: never = section;
      return unhandled;
    }
  }
}
