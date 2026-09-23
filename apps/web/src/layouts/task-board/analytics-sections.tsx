/**
 * Three renderers for the analytics envelope — 31 dashboard panels collapse to
 * `stat`, `series` and `table`, so this is the whole presentation layer.
 *
 * Section titles and column names come from the server verbatim (English, like
 * every other server-originated string); only the page chrome is translated.
 */

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
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
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import type { AnalyticsSection } from "@/hooks/use-task-board-analytics";

/** Fixed order, never cycled — a series keeps its hue as the set changes. */
const SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

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
  if (unit === "%") return `${value}%`;
  if (unit === "USD") return `$${value.toFixed(2)}`;
  return value.toLocaleString();
}

function StatCard({
  section,
}: {
  section: Extract<AnalyticsSection, { kind: "stat" }>;
}) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {section.values.map((v) => (
        <div key={v.label} className="rounded-lg border border-border p-4">
          <div className="text-sm text-muted-foreground">{v.label}</div>
          <div className="mt-1 text-2xl font-medium text-foreground tabular-nums">
            {formatValue(v.value, v.unit)}
          </div>
        </div>
      ))}
    </div>
  );
}

function SeriesCard({
  section,
}: {
  section: Extract<AnalyticsSection, { kind: "series" }>;
}) {
  const keys = Array.from(
    new Set(section.points.flatMap((p) => Object.keys(p))),
  ).filter((k) => k !== "t");

  const config: ChartConfig = Object.fromEntries(
    keys.map((k, i) => [
      k,
      { label: k, color: SERIES_COLORS[i % SERIES_COLORS.length] },
    ]),
  );

  const data = section.points.map((p) => ({
    ...p,
    label: String(p.t ?? "").slice(0, 10),
  }));

  if (data.length === 0) {
    return (
      <div className="rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">
        No data in this range
      </div>
    );
  }

  return (
    <ChartContainer
      role="img"
      aria-label={section.title}
      className="h-64 w-full"
      config={config}
    >
      <LineChart data={data} margin={{ left: 0, right: 8, top: 8, bottom: 8 }}>
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
          tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          interval="preserveStartEnd"
          tickMargin={8}
        />
        <YAxis
          axisLine={false}
          tickLine={false}
          tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          tickFormatter={(v: number) =>
            section.unit === "s" ? formatDuration(v) : String(v)
          }
          width={48}
        />
        <ChartTooltip
          cursor={{ stroke: "var(--border)", strokeDasharray: "4 4" }}
          content={
            <ChartTooltipContent
              formatter={(value) =>
                formatValue(Number(value), section.unit ?? undefined)
              }
            />
          }
        />
        {keys.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
        {keys.map((k, i) => (
          <Line
            key={k}
            type="linear"
            dataKey={k}
            stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, stroke: "var(--background)", strokeWidth: 2 }}
            animationDuration={300}
          />
        ))}
      </LineChart>
    </ChartContainer>
  );
}

/** `/$org/$taskId` is the forever-supported way into any org's thread. */
function threadHref(org: string, threadId: string): string {
  return `/${encodeURIComponent(org)}/${encodeURIComponent(threadId)}`;
}

function TableCard({
  section,
  threadLinks,
}: {
  section: Extract<AnalyticsSection, { kind: "table" }>;
  threadLinks?: boolean;
}) {
  const orgCol = section.columns.indexOf("Org");
  const threadCol =
    threadLinks && orgCol >= 0 ? section.columns.indexOf("Thread") : -1;
  if (section.rows.length === 0) {
    return (
      <div className="rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">
        Nothing to show
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            {section.columns.map((c) => (
              <TableHead key={c} className="whitespace-nowrap">
                {c}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {section.rows.map((row, i) => (
            <TableRow key={`${section.title}-${i}`}>
              {row.map((value, j) => (
                <TableCell
                  key={section.columns[j] ?? String(j)}
                  className="max-w-md truncate text-sm tabular-nums"
                >
                  {value === null ? (
                    "—"
                  ) : j === threadCol ? (
                    <a
                      href={threadHref(String(row[orgCol]), String(value))}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary underline-offset-2 hover:underline"
                    >
                      {String(value)}
                    </a>
                  ) : (
                    String(value)
                  )}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function SectionView({
  section,
  threadLinks,
}: {
  section: AnalyticsSection;
  /** Render a "Thread" column as a link into its row's "Org". */
  threadLinks?: boolean;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">{section.title}</h3>
      {section.kind === "stat" && <StatCard section={section} />}
      {section.kind === "series" && <SeriesCard section={section} />}
      {section.kind === "table" && (
        <TableCard section={section} threadLinks={threadLinks} />
      )}
    </section>
  );
}
