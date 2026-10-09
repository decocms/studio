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
import { ArrowDown, ArrowUp } from "@untitledui/icons";
import type { ReactNode } from "react";
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
import { timeAgo } from "@/lib/format-time";
import { STATUS_CONFIG } from "./config";

type SectionOf<K extends AnalyticsSection["kind"]> = Extract<
  AnalyticsSection,
  { kind: K }
>;

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

function formatCell(value: string | number, unit?: string): string {
  if (typeof value === "number") return formatValue(value, unit);
  return ISO_TIMESTAMP.test(value) ? timeAgo(value) : value;
}

/** The Monitor's metric card: a quiet title, one figure, then the detail. */
function MetricCard({
  title,
  value,
  caption,
  aside,
  children,
}: {
  title: string;
  value?: ReactNode;
  caption?: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="surface flex h-full flex-col gap-6 px-4 pt-4 pb-5">
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
    </section>
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
  6: "lg:grid-cols-3",
  9: "lg:grid-cols-3",
};

function StatCards({ section }: { section: SectionOf<"stat"> }) {
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
          caption={
            v.previous !== undefined && (
              <Delta
                value={v.value}
                previous={v.previous}
                unit={v.unit}
                better={v.better}
              />
            )
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
}: {
  active?: boolean;
  payload?: {
    dataKey?: unknown;
    value?: unknown;
    color?: string;
    payload?: { t?: unknown };
  }[];
  unit?: string;
}) {
  if (!active || !payload?.length) return null;
  const t = payload[0]?.payload?.t;
  return (
    <div className="rounded-lg border bg-background px-3 py-2 shadow-md">
      <div className="mb-1 text-xs text-muted-foreground">
        {typeof t === "string"
          ? new Date(t).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })
          : ""}
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
              {String(item.dataKey)}
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
}: {
  label: string;
  note?: string;
  share?: string;
  value: string;
  fill: number;
  color: string;
}) {
  return (
    <li className="flex h-10 items-center gap-3 border-b border-border/50 last:border-b-0">
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
    </li>
  );
}

/** Each stage against the first; the figure is how many made it all the way. */
function FunnelCard({ section }: { section: SectionOf<"funnel"> }) {
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
              />
            );
          })}
        </ol>
      )}
    </MetricCard>
  );
}

function BarsCard({ section }: { section: SectionOf<"bars"> }) {
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
              share={bar.detail}
              value={bar.value.toLocaleString()}
              fill={max ? (100 * bar.value) / max : 0}
              color="var(--chart-1)"
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

/** Columns that only say something across tenants. */
const CROSS_ORG_COLUMNS = new Set(["Org", "Orgs"]);

function TableCard({
  section,
  threadLinks,
  showOrg,
  taskHref,
}: {
  section: SectionOf<"table">;
  threadLinks?: boolean;
  showOrg?: boolean;
  taskHref?: (taskId: string) => string;
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
    );
  // "Failure kinds" over a "Failure kind" column: the title takes that header.
  const first = shown[0]?.c ?? "";
  const titleInHeader =
    section.rows.length > 0 &&
    section.title.toLowerCase() === `${first.toLowerCase()}s`;

  return (
    <section className="surface flex flex-col overflow-hidden">
      {!titleInHeader && (
        <h3 className="px-4 pt-4 pb-3 text-sm text-foreground/70">
          {section.title}
        </h3>
      )}
      {section.rows.length === 0 ? (
        <Empty>{t("taskBoard.analytics.nothingToShow")}</Empty>
      ) : (
        <div
          className={cn(
            "max-h-[480px] overflow-auto",
            !titleInHeader && "border-t border-border/50",
          )}
        >
          <Table variant="flush">
            <TableHeader>
              <TableRow>
                {shown.map(({ c }, k) =>
                  titleInHeader && k === 0 ? (
                    <TableHead key={c} className="pl-4">
                      <h3 className="text-sm font-normal text-foreground/70">
                        {section.title}
                      </h3>
                    </TableHead>
                  ) : (
                    <TableHead
                      key={c}
                      className="whitespace-nowrap first:pl-4 last:pr-4"
                    >
                      {c === "Thread" ? "" : c}
                    </TableHead>
                  ),
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {section.rows.map((row, i) => (
                <TableRow key={`${section.title}-${i}`}>
                  {shown.map(({ c, j }) => {
                    const value = row[j];
                    const taskId = taskCol === j ? row[taskIdCol] : null;
                    return (
                      <TableCell
                        key={c}
                        className="max-w-md truncate text-sm first:pl-4 last:pr-4"
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
                            className="focus-ring text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                          >
                            {t("taskBoard.analytics.openChat")}
                          </a>
                        ) : taskId ? (
                          <a
                            href={taskHref?.(String(taskId))}
                            className="focus-ring text-foreground underline-offset-2 hover:underline"
                          >
                            {String(value)}
                          </a>
                        ) : c === "Lane" &&
                          Object.hasOwn(STATUS_CONFIG, value) ? (
                          <span className="text-muted-foreground">
                            {t(
                              STATUS_CONFIG[value as keyof typeof STATUS_CONFIG]
                                .labelKey,
                            )}
                          </span>
                        ) : (
                          <span className="tnum">
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
    </section>
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
}) {
  switch (section.kind) {
    case "stat":
      return <StatCards section={section} />;
    case "series":
      return <SeriesCard section={section} range={range} />;
    case "funnel":
      return <FunnelCard section={section} />;
    case "bars":
      return <BarsCard section={section} />;
    case "table":
      return (
        <TableCard
          section={section}
          threadLinks={threadLinks}
          showOrg={showOrg}
          taskHref={taskHref}
        />
      );
    default: {
      const unhandled: never = section;
      return unhandled;
    }
  }
}
