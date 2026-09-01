/**
 * AnalyticsTab — per-site Deco Analytics, tenant-scoped.
 *
 * Two halves, both per-site and both server-proxied so no upstream token ever
 * reaches the browser:
 *
 *   1. Dashboard — the read surface's `/data` views (overview, behaviour,
 *      events, …) rendered as collapsible sections. Each section fetches
 *      `GET /analytics/data?view=&range=` lazily on open. The BFF resolves the
 *      warehouse site_id from a slug the org owns and refuses any payload the
 *      warehouse did not scope to this tenant, so a section can only ever show
 *      this site's numbers. `pipeline` is intentionally not offered — it is an
 *      operator view with no tenant policy.
 *
 *   2. Configuration — the lifecycle (register → configure / pause-resume /
 *      unregister) that used to be the whole tab, now one collapsible section.
 *
 * Status drives the shell: `configured === false` → collector not wired;
 * `!registered` → the Register card is the whole tab (nothing to chart yet);
 * `registered` → dashboard sections + a Configuration section. A 401 anywhere
 * shows the calm "not connected" state; the data surface being unset degrades to
 * "dashboard unavailable" while configuration still works.
 *
 * IMPORTANT: this tab ships in the open-source Studio. It shows only what a site
 * owner needs — never delivery/caching/billing internals (the BFF strips the
 * read surface's `worker`/`install` internals before they reach here).
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BarChartSquare02,
  Check,
  ChevronRight,
  Copy01,
  Pencil01,
  Power03,
  Settings01,
  Trash01,
} from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Checkbox } from "@decocms/ui/components/checkbox.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@decocms/ui/components/table.tsx";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@decocms/ui/components/chart.tsx";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@decocms/ui/components/alert-dialog.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { toast } from "sonner";
import { useProjectContext, useVirtualMCP } from "@/sdk";
import { resolveAgentSiteSlug } from "@decocms/shared/site-slug";
import { KEYS } from "@/lib/query-keys";
import { useT, type TFunction } from "@/i18n/use-t.ts";

// --- control-plane REST DTOs (client-safe fields only) ---------------------

interface SiteConfig {
  id?: string;
  enabled?: boolean;
  sampling?: number;
  tier?: string;
  modules?: string[];
  domains?: string[];
  /** Accepted events per calendar month (uncapped when absent). */
  quota?: number;
}
interface AnalyticsStatus {
  configured?: boolean;
  registered?: boolean;
  host?: string | null;
  config?: SiteConfig | null;
  /** The public declared key (`dq_…`) for a keyed site — it ships in the page,
   *  so it is shown, not hidden. */
  key?: string | null;
}

/** The BFF's `/analytics/data` envelope. `data` is the read surface's per-view
 *  payload (delivery/bundle internals already stripped server-side). */
interface AnalyticsDataResponse {
  registered?: boolean;
  siteId?: string;
  view?: string;
  range?: string;
  data?: Record<string, unknown>;
}

/** The one-time result of a registration. `key`/`snippet` come back once, at
 *  creation, and only for a token (key) registration; `notes` carries the
 *  collector's warnings (e.g. `deco` auto-added, or the `_dq` route not yet
 *  reachable). */
interface AnalyticsRegisterResult {
  registered?: boolean;
  host?: string | null;
  key?: string | null;
  snippet?: string | null;
  notes?: string[];
}

// The modules a site can enable. `core` is always on (the collector forces it),
// so it renders checked + locked. Labels/hints come from i18n. `as const` keeps
// the label/hint keys as literal `TranslationKey`s so `t()` accepts them.
const MODULES = [
  {
    key: "core",
    labelKey: "mainPanelTabs.analyticsTab.moduleCore",
    hintKey: "mainPanelTabs.analyticsTab.moduleCoreHint",
  },
  {
    key: "commerce",
    labelKey: "mainPanelTabs.analyticsTab.moduleCommerce",
    hintKey: "mainPanelTabs.analyticsTab.moduleCommerceHint",
  },
  {
    key: "vitals",
    labelKey: "mainPanelTabs.analyticsTab.moduleVitals",
    hintKey: "mainPanelTabs.analyticsTab.moduleVitalsHint",
  },
  {
    key: "errors",
    labelKey: "mainPanelTabs.analyticsTab.moduleErrors",
    hintKey: "mainPanelTabs.analyticsTab.moduleErrorsHint",
  },
  {
    key: "engagement",
    labelKey: "mainPanelTabs.analyticsTab.moduleEngagement",
    hintKey: "mainPanelTabs.analyticsTab.moduleEngagementHint",
  },
] as const;

// The dashboard views, as a horizontal tab bar in the order the internal admin
// UI shows them. Labels are the admin's product names (kept literal — the shared
// i18n file is churning under another workstream). `pipeline` (operator-only, no
// tenant policy) and `install` (only stripped internals) are omitted.
const DATA_VIEWS: ReadonlyArray<{ view: string; label: string }> = [
  { view: "live", label: "Realtime" },
  { view: "overview", label: "Overview" },
  { view: "behaviour", label: "Pages & sources" },
  { view: "events", label: "Events & props" },
  { view: "errors", label: "Errors" },
  { view: "experiments", label: "Experiments" },
  { view: "vitals", label: "Web Vitals" },
  { view: "quality", label: "Data quality" },
  { view: "usage", label: "Usage & limits" },
];

// Range pills, shortest first — the admin's 5m…30d selector.
const RANGE_PILLS = ["5m", "15m", "30m", "1h", "24h", "7d", "30d"] as const;

// Keys in a view payload that are context, not panels — never rendered as data.
const META_KEYS = new Set([
  "usageScope",
  "currency",
  "currencies",
  "dimensions",
  "operators",
  "goals",
  "goal",
  "range",
  "site",
  "view",
  "propKey",
  "filters",
  "usageExplained",
]);

// A column name that reads as a time bucket → the panel is a series.
const TIME_KEY = /^(t|ts|bucket|minute|min|hour|day|date)$/i;

// --- helpers ----------------------------------------------------------------

/** The pre-token condition: the upstream (or its proxy) answers 401. Rendered as
 *  a calm "not connected" state, not a red error. */
function isUnauthorized(error: unknown): boolean {
  const m = error instanceof Error ? error.message.toLowerCase() : "";
  return m.includes("unauthorized") || m.includes("401");
}

/** The upstream/proxy answers "not configured" (503) — a friendly "no data"
 *  state, not an error. Matches both the control-plane's `not_configured` and
 *  the BFF's "…is not configured" for the data surface. */
function isNotConfigured(error: unknown): boolean {
  const m = error instanceof Error ? error.message.toLowerCase() : "";
  return m.includes("not_configured") || m.includes("not configured");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** camelCase / snake_case panel or column key → a readable label. */
function humanize(key: string): string {
  const spaced = key
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatNumber(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat().format(n);
}

/** Render any warehouse cell. Arrays (e.g. `_trunc`) may arrive as `null` on
 *  some clients — coalesce to a dash rather than reading "no flags" where there
 *  are flags. Objects are shown compactly; numbers get thousands separators. */
function formatCell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) {
    return value.length ? value.map((v) => String(v)).join(", ") : "—";
  }
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function isScalar(value: unknown): boolean {
  return (
    value === null || ["string", "number", "boolean"].includes(typeof value)
  );
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `request failed (${res.status})`;
    throw new Error(err);
  }
  return body;
}

async function mutateJson(
  url: string,
  method: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `request failed (${res.status})`;
    throw new Error(err);
  }
  return data;
}

// --- section shell ----------------------------------------------------------

function Card({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {action && <div className="ml-auto">{action}</div>}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

// --- generic panel rendering ------------------------------------------------

/** Format a metric value for display, keyed on its column name: percentages,
 *  durations (seconds → `10m 7s`), and plain counts each read differently. */
function fmtMetric(key: string, value: unknown): string {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return formatCell(value);
  if (/(pct|rate|bounce|ratio)/i.test(key)) return `${Math.round(n)}%`;
  if (/(_s$|duration|seconds)/i.test(key)) {
    const m = Math.floor(n / 60);
    return m ? `${m}m ${Math.round(n % 60)}s` : `${Math.round(n)}s`;
  }
  return formatNumber(n);
}

/** Friendly, product titles for the payload's panel keys — so a breakdown reads
 *  as "Top pages" / "Referrers" rather than the raw column name. Falls back to a
 *  humanized key. */
const PANEL_TITLES: Record<string, string> = {
  kpis: "Overview",
  series: "Traffic over time",
  funnel: "Funnel",
  sources: "Top sources",
  pages: "Top pages",
  entryPages: "Entry pages",
  exitPages: "Exit pages",
  devices: "Devices",
  os: "Operating systems",
  browser: "Browsers",
  countries: "Countries",
  regions: "Regions",
  cities: "Cities",
  channels: "Channels",
  channelConversion: "Channel conversion",
  campaigns: "Campaigns",
  campaignNames: "Campaign names",
  attribution: "Attribution",
  products: "Top products",
  events: "Events",
  errors: "Errors",
  propKeys: "Property keys",
  propValues: "Property values",
  scrollDepth: "Scroll depth",
  searches: "Site searches",
  outbound: "Outbound links",
  downloads: "Downloads",
  variants: "Experiment variants",
  vitals: "Web vitals",
  vitalsByPage: "Vitals by page",
  liveVisitors: "Live visitors",
  livePages: "Active pages",
  liveFeed: "Live feed",
  liveByMinute: "Visitors per minute",
  usage: "Usage",
  usageTrend: "Usage over time",
  usageSites: "Usage by site",
};

/** Preferred order for the breakdown grid — the most useful first, then the rest
 *  in payload order. */
const PANEL_ORDER = [
  "pages",
  "sources",
  "channels",
  "devices",
  "browser",
  "os",
  "countries",
  "regions",
  "cities",
  "entryPages",
  "exitPages",
  "campaigns",
  "products",
  "events",
  "errors",
];

function panelTitle(name: string): string {
  return PANEL_TITLES[name] ?? humanize(name);
}

/** Within-window trend for a metric's series: the recent half vs the earlier
 *  half, as a signed percentage. Null when there isn't enough to compare or the
 *  baseline is zero — a "+∞%" from a zero baseline is noise, not a trend. */
function trendPct(values: number[]): number | null {
  if (values.length < 4) return null;
  const mid = Math.floor(values.length / 2);
  const older = values.slice(0, mid).reduce((a, b) => a + b, 0);
  const recent = values.slice(mid).reduce((a, b) => a + b, 0);
  if (older === 0) return null;
  return ((recent - older) / older) * 100;
}

/** A small up/down trend pill. `goodDown` flips the color for metrics where a
 *  drop is good (bounce rate). */
function Delta({ pct, goodDown }: { pct: number; goodDown?: boolean }) {
  const up = pct >= 0;
  const good = goodDown ? !up : up;
  return (
    <span
      className={cn(
        "text-xs font-medium tabular-nums",
        good ? "text-[var(--chart-2,#16a34a)]" : "text-destructive",
      )}
    >
      {up ? "↑" : "↓"}
      {Math.abs(Math.round(pct))}%
    </span>
  );
}

/** The KPI row: a single scalar record → a row of stat tiles. */
// Internal/plumbing metrics that add noise to a customer KPI row.
const KPI_HIDE = new Set(["min_sampling", "sessions_built"]);

function KpiTiles({ row }: { row: Record<string, unknown> }) {
  const entries = Object.entries(row).filter(
    ([k, v]) => (typeof v === "number" || v === null) && !KPI_HIDE.has(k),
  );
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {entries.map(([k, v]) => (
        <div
          key={k}
          className="flex flex-col gap-1.5 rounded-xl border border-border bg-card p-4"
        >
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {humanize(k)}
          </span>
          <span className="text-3xl font-semibold leading-none text-foreground tabular-nums">
            {fmtMetric(k, v)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** A time series as a filled area chart — the hero visual, modelled on the
 *  admin monitor's "Usage over time". Plots one metric over the time bucket. */
/** Compact axis number: 12.3k, 4.5M — matches the monitor's y-axis. */
function formatAxisValue(value: number): string {
  if (!Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/** A time series as one or more filled area lines, styled like the Studio
 *  monitor's KPIChart: `--chart-N` accents, gradient fills, dashed horizontal
 *  grid, a right-hand y-axis, muted 11px ticks, and a legend when there's more
 *  than one metric. */
function AreaTrend({
  rows,
  timeKey,
  metricKeys,
}: {
  rows: Array<Record<string, unknown>>;
  timeKey: string;
  metricKeys: string[];
}) {
  const keys = metricKeys.filter(Boolean).slice(0, 4);
  const colors = keys.map((_, i) => `var(--chart-${(i % 5) + 1})`);
  const data = rows.map((r) => {
    const o: Record<string, unknown> = { label: String(r[timeKey] ?? "") };
    for (const k of keys) o[k] = Number(r[k]) || 0;
    return o;
  });
  const config = Object.fromEntries(
    keys.map((k, i) => [k, { label: humanize(k), color: colors[i] }]),
  );
  return (
    <ChartContainer config={config} className="h-64 w-full">
      <AreaChart data={data} margin={{ top: 8, right: -8, bottom: 8, left: 0 }}>
        <defs>
          {keys.map((k, i) => (
            <linearGradient
              key={k}
              id={`dq-grad-${k}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor={colors[i]} stopOpacity={0.2} />
              <stop offset="100%" stopColor={colors[i]} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
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
          tick={{ fontSize: 11, fill: "var(--muted-foreground)", opacity: 0.7 }}
          tickMargin={8}
          minTickGap={40}
          interval="preserveStartEnd"
          tickFormatter={(v: string) => v.replace("T", " ").slice(5, 16)}
        />
        <YAxis
          orientation="right"
          axisLine={false}
          tickLine={false}
          tick={{ fontSize: 11, fill: "var(--muted-foreground)", opacity: 0.7 }}
          tickFormatter={formatAxisValue}
          width={40}
          tickCount={5}
        />
        <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
        {keys.map((k, i) => (
          <Area
            key={k}
            type="linear"
            dataKey={k}
            stroke={colors[i]}
            strokeWidth={2}
            fill={`url(#dq-grad-${k})`}
            dot={false}
            activeDot={{
              r: 4,
              fill: colors[i],
              stroke: "var(--background)",
              strokeWidth: 2,
            }}
            animationDuration={300}
          />
        ))}
        {keys.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
      </AreaChart>
    </ChartContainer>
  );
}

/** A ranked breakdown as horizontal bars with value + share — the
 *  "most viewed pages" / "cache status" pattern. */
function BarList({
  rows,
  labelKey,
  valueKey,
}: {
  rows: Array<Record<string, unknown>>;
  labelKey: string;
  valueKey: string;
}) {
  const top = [...rows]
    .sort((a, b) => (Number(b[valueKey]) || 0) - (Number(a[valueKey]) || 0))
    .slice(0, 10);
  const max = Math.max(1, ...top.map((r) => Number(r[valueKey]) || 0));
  const total =
    rows.reduce((sum, r) => sum + (Number(r[valueKey]) || 0), 0) || 1;
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-2.5 pb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <span>{humanize(labelKey)}</span>
        <span>{humanize(valueKey)}</span>
      </div>
      <div className="flex flex-col gap-0.5">
        {top.map((r, i) => {
          const v = Number(r[valueKey]) || 0;
          return (
            <div
              key={i}
              className="relative flex items-center justify-between gap-3 overflow-hidden rounded-md px-2.5 py-2"
            >
              <div
                className="absolute inset-y-0 left-0 rounded-md bg-muted"
                style={{ width: `${(v / max) * 100}%` }}
              />
              <span className="relative z-10 truncate font-mono text-xs text-foreground">
                {formatCell(r[labelKey]) || "—"}
              </span>
              <span className="relative z-10 shrink-0 text-sm tabular-nums text-foreground">
                {formatNumber(v)}
                <span className="ml-2 text-xs text-muted-foreground">
                  {Math.round((v / total) * 100)}%
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The commerce funnel: steps as bars scaled to the first step, each labelled
 *  with its conversion off the top. */
function Funnel({ row }: { row: Record<string, unknown> }) {
  const order = [
    ["viewed", "Viewed"],
    ["view_item", "View item"],
    ["view_item_list", "View list"],
    ["select_item", "Select item"],
    ["add_to_cart", "Add to cart"],
    ["begin_checkout", "Begin checkout"],
    ["purchase", "Purchase"],
  ] as const;
  const steps = order.filter(([k]) => k in row);
  const base = Number(row[steps[0]?.[0] ?? ""]) || 1;
  return (
    <div className="flex flex-col gap-1.5">
      {steps.map(([k, label]) => {
        const v = Number(row[k]) || 0;
        return (
          <div
            key={k}
            className="relative flex items-center justify-between gap-3 overflow-hidden rounded-md px-2.5 py-2"
          >
            <div
              className="absolute inset-y-0 left-0 rounded-md bg-primary/15"
              style={{ width: `${(v / base) * 100}%` }}
            />
            <span className="relative z-10 text-sm text-foreground">
              {label}
            </span>
            <span className="relative z-10 shrink-0 text-sm tabular-nums text-muted-foreground">
              {formatNumber(v)}
              <span className="ml-2 text-xs opacity-70">
                {Math.round((v / base) * 100)}%
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function DataTable({ rows }: { rows: Array<Record<string, unknown>> }) {
  const columns = Array.from(
    rows.reduce<Set<string>>((set, row) => {
      Object.keys(row).forEach((k) => set.add(k));
      return set;
    }, new Set()),
  );
  // A numeric column is right-aligned and formatted like a metric; everything
  // else stays left. Sort the visible rows by the first numeric column so the
  // table reads as a ranking, not raw order.
  const numeric = new Set(
    columns.filter((c) => rows.some((r) => typeof r[c] === "number")),
  );
  const firstNum = columns.find((c) => numeric.has(c));
  const shown = [...rows]
    .sort((a, b) =>
      firstNum ? (Number(b[firstNum]) || 0) - (Number(a[firstNum]) || 0) : 0,
    )
    .slice(0, 50);
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="border-border hover:bg-transparent">
            {columns.map((c) => (
              <TableHead
                key={c}
                className={cn(
                  "h-8 whitespace-nowrap text-[11px] font-medium uppercase tracking-wide text-muted-foreground",
                  numeric.has(c) && "text-right",
                )}
              >
                {humanize(c)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((row, i) => (
            <TableRow key={i} className="border-border/50">
              {columns.map((c) => (
                <TableCell
                  key={c}
                  className={cn(
                    "whitespace-nowrap py-1.5 text-sm tabular-nums",
                    numeric.has(c)
                      ? "text-right text-foreground"
                      : "font-mono text-xs text-muted-foreground",
                  )}
                >
                  {typeof row[c] === "number"
                    ? fmtMetric(c, row[c])
                    : formatCell(row[c])}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** One panel from a view payload, shape-detected and rendered first-class:
 *  the funnel → a stepped funnel; a single scalar row → KPI tiles; a time
 *  series → an area chart; a label+value breakdown → a ranked bar list;
 *  anything else → a table. */
type PanelKind = "kpi" | "series" | "funnel" | "bars" | "table";

/** Shape-detect a panel into a visual kind, or null when there's nothing to
 *  show. Empty panels are dropped so the layout stays dense. */
function classifyPanel(rows: Array<Record<string, unknown>>): {
  kind: PanelKind;
  timeKey?: string;
  metricKeys?: string[];
  labelKey?: string;
  valueKey?: string;
} | null {
  if (rows.length === 0) return null;
  const first = rows[0] ?? {};
  const columns = Object.keys(first);

  // The commerce funnel — a single row of ordered step counts.
  if (
    rows.length === 1 &&
    ("viewed" in first || "purchase" in first || "add_to_cart" in first)
  ) {
    return { kind: "funnel" };
  }

  const timeKey = columns.find((c) => TIME_KEY.test(c));
  const metricKeys = timeKey
    ? columns.filter((c) => c !== timeKey && typeof first[c] === "number")
    : [];
  // A time series → area chart (needs more than one bucket to be a line).
  if (timeKey && metricKeys.length > 0 && rows.length > 1) {
    return { kind: "series", timeKey, metricKeys };
  }

  // A breakdown: a NON-time text label + a numeric value. Checked BEFORE the KPI
  // case so a single-row breakdown ({ k: "Direct", n: 1 }) renders as a one-item
  // bar list, not as a stack of "N: 1" KPI tiles.
  const labelKey = columns.find(
    (c) => c !== timeKey && typeof first[c] === "string",
  );
  const valueKey = columns.find((c) => typeof first[c] === "number");
  if (labelKey && valueKey && columns.length <= 3) {
    return { kind: "bars", labelKey, valueKey };
  }

  // A KPI card: a single row of named metrics with no text label and no time
  // column (e.g. the `kpis` panel: visitors/pageviews/sessions/…).
  if (
    rows.length === 1 &&
    !timeKey &&
    !labelKey &&
    Object.values(first).every(isScalar)
  ) {
    return { kind: "kpi" };
  }

  return { kind: "table" };
}

/** One classified panel's inner content (no wrapper). */
function PanelBody({
  rows,
  meta,
}: {
  rows: Array<Record<string, unknown>>;
  meta: NonNullable<ReturnType<typeof classifyPanel>>;
}) {
  const first = rows[0] ?? {};
  switch (meta.kind) {
    case "kpi":
      return <KpiTiles row={first} />;
    case "funnel":
      return <Funnel row={first} />;
    case "series":
      return (
        <AreaTrend
          rows={rows}
          timeKey={meta.timeKey ?? ""}
          metricKeys={meta.metricKeys ?? []}
        />
      );
    case "bars":
      return (
        <BarList
          rows={rows}
          labelKey={meta.labelKey ?? ""}
          valueKey={meta.valueKey ?? ""}
        />
      );
    default:
      return <DataTable rows={rows} />;
  }
}

/** Render a view payload as a designed dashboard: the KPI row on top, the time
 *  series and funnel full width beneath it, and the ranked breakdowns in a
 *  two-column grid — modelled on the admin monitor rather than a flat stack.
 *  Empty panels are dropped. */
function ViewPanels({
  payload,
  t,
}: {
  payload: Record<string, unknown>;
  t: TFunction;
}) {
  const classified = (
    Object.entries(payload).filter(
      ([key, value]) => !META_KEYS.has(key) && Array.isArray(value),
    ) as Array<[string, Array<Record<string, unknown>>]>
  )
    .map(([name, rows]) => ({ name, rows, meta: classifyPanel(rows) }))
    .filter((p): p is typeof p & { meta: NonNullable<typeof p.meta> } =>
      Boolean(p.meta),
    );

  if (classified.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("mainPanelTabs.analyticsTab.emptyView")}
      </p>
    );
  }

  const kpis = classified.filter((p) => p.meta.kind === "kpi");
  const wide = classified.filter(
    (p) => p.meta.kind === "series" || p.meta.kind === "funnel",
  );
  const grid = classified
    .filter((p) => p.meta.kind === "bars" || p.meta.kind === "table")
    .sort((a, b) => {
      const ia = PANEL_ORDER.indexOf(a.name);
      const ib = PANEL_ORDER.indexOf(b.name);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });

  return (
    <div className="flex flex-col gap-4">
      {kpis.map((p) => (
        <PanelBody key={p.name} rows={p.rows} meta={p.meta} />
      ))}
      {wide.map((p) => (
        <Card key={p.name} title={panelTitle(p.name)}>
          <PanelBody rows={p.rows} meta={p.meta} />
        </Card>
      ))}
      {grid.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {grid.map((p) => (
            <Card key={p.name} title={panelTitle(p.name)}>
              <PanelBody rows={p.rows} meta={p.meta} />
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// --- overview: the curated, GA4/OneDollar-style home ------------------------

/** Headline metrics, in display order. Labels are analytics-standard names
 *  (kept literal rather than i18n for now). Only the ones the payload actually
 *  carries are shown; the ones that also have a time series are clickable and
 *  drive the hero chart. */
const OVERVIEW_METRICS: ReadonlyArray<[string, string]> = [
  ["visitors", "Visitors"],
  ["pageviews", "Pageviews"],
  ["sessions", "Sessions"],
  ["bounce_pct", "Bounce rate"],
  ["duration_s", "Avg duration"],
];

/** The Overview rendered as a real analytics home: clickable headline metrics
 *  driving one hero time-series, then the ranked breakdowns and the funnel —
 *  the GA4 / OneDollarStats shape, not a generic panel dump. */
function OverviewDashboard({ payload }: { payload: Record<string, unknown> }) {
  const rowsOf = (k: string) =>
    (Array.isArray(payload[k]) ? payload[k] : []) as Array<
      Record<string, unknown>
    >;
  const kpis = rowsOf("kpis")[0] ?? {};
  const series = rowsOf("series");
  const sources = rowsOf("sources");
  const funnel = rowsOf("funnel")[0];

  const seriesCols = series[0]
    ? Object.keys(series[0]).filter(
        (c) => !TIME_KEY.test(c) && typeof series[0]?.[c] === "number",
      )
    : [];
  const metrics = OVERVIEW_METRICS.filter(([k]) => k in kpis);
  const [selected, setSelected] = useState<string>(
    metrics.find(([k]) => seriesCols.includes(k))?.[0] ?? seriesCols[0] ?? "",
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {metrics.map(([k, label]) => {
          const canChart = seriesCols.includes(k);
          const active = selected === k;
          const trend = canChart
            ? trendPct(series.map((r) => Number(r[k]) || 0))
            : null;
          return (
            <button
              key={k}
              type="button"
              disabled={!canChart}
              onClick={() => canChart && setSelected(k)}
              className={cn(
                "flex flex-col gap-1.5 rounded-xl border p-4 text-left transition-colors",
                active
                  ? "border-[var(--chart-1)] bg-[var(--chart-1)]/5"
                  : "border-border bg-card",
                canChart
                  ? "cursor-pointer hover:border-[var(--chart-1)]/60"
                  : "cursor-default",
              )}
            >
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {label}
              </span>
              <span className="flex items-baseline gap-2">
                <span className="text-3xl font-semibold leading-none text-foreground tabular-nums">
                  {fmtMetric(k, kpis[k])}
                </span>
                {trend !== null && (
                  <Delta pct={trend} goodDown={k === "bounce_pct"} />
                )}
              </span>
            </button>
          );
        })}
      </div>

      {selected && series.length > 0 && (
        <Card title={`${humanize(selected)} over time`}>
          <AreaTrend rows={series} timeKey="t" metricKeys={[selected]} />
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {sources.length > 0 && (
          <Card title="Top sources">
            <BarList rows={sources} labelKey="k" valueKey="n" />
          </Card>
        )}
        {funnel && (
          <Card title="Funnel">
            <Funnel row={funnel} />
          </Card>
        )}
      </div>
    </div>
  );
}

// --- realtime: the curated "now" view ---------------------------------------

/** The Realtime view, modelled on the admin monitor: Visitors / Pageviews /
 *  Events / Last event headline cards, then the live feed and the pages active
 *  right now. Fed by the `live` payload (a 5m window, auto-refreshed). */
function RealtimeDashboard({ payload }: { payload: Record<string, unknown> }) {
  const t = useT();
  const rowsOf = (k: string) =>
    (Array.isArray(payload[k]) ? payload[k] : []) as Array<
      Record<string, unknown>
    >;
  const kpi = rowsOf("liveVisitors")[0] ?? {};
  const feed = rowsOf("liveFeed");
  const pages = rowsOf("livePages");
  const cards: ReadonlyArray<[string, string]> = [
    ["visitors", "Visitors"],
    ["pageviews", "Pageviews"],
    ["events", "Events"],
    ["last_event", "Last event"],
  ];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--chart-1)] opacity-75" />
          <span className="relative inline-flex size-2 rounded-full bg-[var(--chart-1)]" />
        </span>
        {t("mainPanelTabs.analyticsTab.liveHint")}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {cards.map(([k, label]) => (
          <div
            key={k}
            className="flex flex-col gap-1.5 rounded-xl border border-border bg-card p-4"
          >
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {label}
            </span>
            <span className="text-3xl font-semibold leading-none text-foreground tabular-nums">
              {k === "last_event" ? formatCell(kpi[k]) : fmtMetric(k, kpi[k])}
            </span>
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Live feed">
          {feed.length > 0 ? (
            <DataTable rows={feed} />
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("mainPanelTabs.analyticsTab.emptyLive")}
            </p>
          )}
        </Card>
        <Card title="Pages right now">
          {pages.length > 0 ? (
            <BarList rows={pages} labelKey="k" valueKey="n" />
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("mainPanelTabs.analyticsTab.emptyView")}
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}

// --- the active view (one at a time, driven by the tab bar) ------------------

function ActiveView({
  base,
  orgSlug,
  site,
  view,
  range,
  quota,
}: {
  base: string;
  orgSlug: string;
  site: string;
  view: string;
  range: string;
  /** The registration's monthly cap, for the Usage & limits banner. */
  quota?: number;
}) {
  const t = useT();
  // Realtime is "now": a short window, auto-refreshed. Everything else follows
  // the selected range as a snapshot.
  const isLive = view === "live";
  const effectiveRange = isLive ? "5m" : range;

  const query = useQuery({
    queryKey: KEYS.analyticsData(orgSlug, site, view, effectiveRange),
    queryFn: () =>
      fetchJson(
        `${base}/analytics/data?view=${encodeURIComponent(
          view,
        )}&range=${encodeURIComponent(effectiveRange)}`,
      ),
    retry: false,
    staleTime: isLive ? 0 : 30_000,
    refetchInterval: isLive ? 5_000 : false,
  });

  if (query.isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (query.error) {
    return (
      <p className="text-sm text-muted-foreground">
        {isNotConfigured(query.error)
          ? t("mainPanelTabs.analyticsTab.dataNotConfiguredDescription")
          : t("mainPanelTabs.analyticsTab.dataLoadError")}
      </p>
    );
  }
  const response = (query.data ?? {}) as AnalyticsDataResponse;
  if (!response.data) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("mainPanelTabs.analyticsTab.emptyView")}
      </p>
    );
  }
  if (isLive) return <RealtimeDashboard payload={response.data} />;
  if (view === "overview") {
    return <OverviewDashboard payload={response.data} />;
  }
  if (view === "usage") {
    return (
      <div className="flex flex-col gap-5">
        <QuotaBanner quota={quota} payload={response.data} />
        <ViewPanels payload={response.data} t={t} />
      </div>
    );
  }
  return <ViewPanels payload={response.data} t={t} />;
}

/** The Usage & limits header: the monthly cap and, when the payload carries an
 *  accepted total, how much of it this window used. The cap is a CALENDAR-MONTH
 *  limit, so the bar is only drawn against a month-scoped total; for a shorter
 *  range it shows the cap and points at the site's control-plane detail for the
 *  authoritative month-to-date consumption and enforcement state. */
function QuotaBanner({
  quota,
  payload,
}: {
  quota?: number;
  payload: Record<string, unknown>;
}) {
  const capped = typeof quota === "number" && quota > 0;
  // Pull an accepted total out of the payload. The summary may arrive either as
  // a scalar object OR — like the other analytics panels — as an array of rows,
  // so inspect the first row of arrays too, else the total never shows.
  let accepted: number | null = null;
  for (const v of Object.values(payload)) {
    const row =
      v && typeof v === "object" && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : Array.isArray(v) && v[0] && typeof v[0] === "object"
          ? (v[0] as Record<string, unknown>)
          : null;
    if (!row) continue;
    const n = row.events_accepted ?? row.accepted ?? row.events;
    if (typeof n === "number") {
      accepted = n;
      break;
    }
  }
  const fmt = (n: number) => n.toLocaleString();

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Monthly quota
        </span>
        <span className="font-mono text-sm tabular-nums text-foreground">
          {capped ? `${fmt(quota!)} events / month` : "Uncapped"}
        </span>
      </div>
      {capped && accepted !== null && (
        <p className="text-xs text-muted-foreground">
          {fmt(accepted)} accepted in the selected range. The cap resets each
          calendar month; the collector drops events once the site is flagged
          over. Month-to-date consumption and the over-quota state are on the
          site's hosting detail.
        </p>
      )}
      {!capped && (
        <p className="text-xs text-muted-foreground">
          No monthly cap is set — every accepted event is stored. Set one in
          Configuration to enforce a limit.
        </p>
      )}
    </div>
  );
}

// --- install / tracking (use-only) ------------------------------------------

/** How to USE analytics for this site — a minimal, use-only summary.
 *  IMPORTANT: this is an internal module surfaced in the (open-source) Studio.
 *  It must NOT demonstrate our delivery / caching / billing internals — only
 *  what the site owner needs: it's active automatically, and custom events are
 *  sent through the public `window.__dq` client API. */
function InstallPanel({ status }: { status: AnalyticsStatus }) {
  const t = useT();
  const id = status.config?.id ?? "";
  // The declared key is public (it ships in the page's `?k=`), so show the real
  // one straight from status rather than a placeholder.
  const token = status.key ?? null;
  const keySnippet = `<script async src="https://analytics.decocdn.com/_dq/a.js?k=${token ?? "YOUR_TOKEN"}"></script>`;
  return (
    <Card title={t("mainPanelTabs.analyticsTab.installTitle")}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          {t("mainPanelTabs.analyticsTab.installHow")}
        </p>

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("mainPanelTabs.analyticsTab.installHostTitle")}
          </span>
          <p className="text-xs text-muted-foreground">
            {t("mainPanelTabs.analyticsTab.installAuto")}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("mainPanelTabs.analyticsTab.installKeyTitle")}
          </span>
          {token && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-3 py-1.5">
              <code className="overflow-x-auto text-xs text-foreground">
                {token}
              </code>
              <CopyButton text={token} />
            </div>
          )}
          <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2">
            <code className="overflow-x-auto whitespace-pre-wrap break-all text-xs text-muted-foreground">
              {keySnippet}
            </code>
            <CopyButton text={keySnippet} />
          </div>
          {!token && (
            <span className="text-xs text-muted-foreground">
              {t("mainPanelTabs.analyticsTab.installTokenNote")}
            </span>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          {t("mainPanelTabs.analyticsTab.installTrackPrefix")}
          <span className="font-mono">window.__dq</span> —{" "}
          <span className="font-mono">pageview()</span>,{" "}
          <span className="font-mono">track(name, props)</span>,{" "}
          <span className="font-mono">purchase(&#123;…&#125;)</span>.
        </p>

        {id && (
          <p className="text-xs text-muted-foreground">
            {t("mainPanelTabs.analyticsTab.installSiteId")}:{" "}
            <span className="font-mono text-foreground">{id}</span>
          </p>
        )}
      </div>
    </Card>
  );
}

// --- register (not yet registered) ------------------------------------------

/** Copy-to-clipboard button for the one-time snippet/token. */
function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        // `navigator.clipboard` is undefined on insecure origins / older
        // browsers; `?.writeText` then returns undefined and `.then` would throw.
        navigator.clipboard?.writeText(text)?.then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => {},
        );
      }}
    >
      {copied ? <Check className="size-4" /> : <Copy01 className="size-4" />}
      {copied
        ? t("mainPanelTabs.analyticsTab.copied")
        : t("mainPanelTabs.analyticsTab.copy")}
    </Button>
  );
}

/** The one-time registration result: the server-built snippet, any notes, and —
 *  for a token registration only — the public token, shown ONCE. Rendered at the
 *  tab level so it survives the flip to the registered view. */
function RegistrationResult({
  result,
  onDismiss,
}: {
  result: AnalyticsRegisterResult;
  onDismiss: () => void;
}) {
  const t = useT();
  const notes = result.notes ?? [];
  const hasKey = Boolean(result.key);
  if (!hasKey && !result.snippet && notes.length === 0) return null;
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4">
      <div className="flex items-start justify-between gap-4">
        <h3 className="text-sm font-medium text-foreground">
          {hasKey
            ? t("mainPanelTabs.analyticsTab.tokenTitle")
            : t("mainPanelTabs.analyticsTab.registeredOk")}
        </h3>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          {t("mainPanelTabs.analyticsTab.dismiss")}
        </Button>
      </div>
      {hasKey && (
        <p className="text-xs text-muted-foreground">
          {t("mainPanelTabs.analyticsTab.tokenOnce")}
        </p>
      )}
      {result.snippet && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2">
          <code className="overflow-x-auto whitespace-pre-wrap break-all text-xs text-muted-foreground">
            {result.snippet}
          </code>
          <CopyButton text={result.snippet} />
        </div>
      )}
      {notes.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {notes.map((n, i) => (
            <li
              key={i}
              className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
            >
              {n}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RegisterCard({
  base,
  orgSlug,
  site,
  host,
  onRegistered,
}: {
  base: string;
  orgSlug: string;
  site: string;
  host: string | null;
  onRegistered: (result: AnalyticsRegisterResult) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(
    new Set(["core", "commerce", "vitals"]),
  );
  const [hostOverride, setHostOverride] = useState("");
  // Token (key) mode: an owned site not on our CDN. The token is public and
  // events are NOT billable, so it is opt-in and clearly marked.
  const [useKey, setUseKey] = useState(false);
  const [domainsText, setDomainsText] = useState("");

  const registerMutation = useMutation<
    AnalyticsRegisterResult,
    Error,
    Record<string, unknown>
  >({
    mutationFn: (input) =>
      mutateJson(
        `${base}/analytics/register`,
        "POST",
        input,
      ) as Promise<AnalyticsRegisterResult>,
    onSuccess: (data) => {
      queryClient.invalidateQueries({
        queryKey: KEYS.analyticsStatus(orgSlug, site),
      });
      onRegistered(data);
      toast.success(t("mainPanelTabs.analyticsTab.toastRegistered"));
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const toggle = (key: string) => {
    if (key === "core") return; // always on
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Split on commas/whitespace so a pasted list works either way.
  const domains = domainsText
    .split(/[\s,]+/)
    .map((d) => d.trim())
    .filter(Boolean);

  const handleRegister = () => {
    if (useKey) {
      registerMutation.mutate({
        key: true,
        domains,
        modules: [...selected],
      });
      return;
    }
    const trimmed = hostOverride.trim();
    registerMutation.mutate({
      modules: [...selected],
      ...(trimmed ? { host: trimmed } : {}),
    });
  };

  const effectiveHost =
    hostOverride.trim() ||
    host ||
    t("mainPanelTabs.analyticsTab.registerHostFallback");

  return (
    <Card title={t("mainPanelTabs.analyticsTab.registerTitle")}>
      <div className="flex flex-col gap-5">
        <p className="text-sm text-muted-foreground">
          {t("mainPanelTabs.analyticsTab.registerDescription", {
            host: useKey ? domains[0] || "your domains" : effectiveHost,
          })}
        </p>

        <div className="flex flex-col gap-2">
          <Label>{t("mainPanelTabs.analyticsTab.modules")}</Label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {MODULES.map((m) => {
              const locked = m.key === "core";
              const on = locked || selected.has(m.key);
              return (
                <label
                  key={m.key}
                  className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 hover:border-border/70"
                >
                  <Checkbox
                    checked={on}
                    disabled={locked}
                    onCheckedChange={() => toggle(m.key)}
                    className="mt-0.5"
                  />
                  <span className="flex flex-col">
                    <span className="text-sm font-medium text-foreground">
                      {t(m.labelKey)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t(m.hintKey)}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 hover:border-border/70">
          <Checkbox
            checked={useKey}
            onCheckedChange={(v) => setUseKey(Boolean(v))}
            className="mt-0.5"
          />
          <span className="flex flex-col">
            <span className="text-sm font-medium text-foreground">
              {t("mainPanelTabs.analyticsTab.registerByKey")}
            </span>
            <span className="text-xs text-muted-foreground">
              {t("mainPanelTabs.analyticsTab.registerByKeyHint")}
            </span>
          </span>
        </label>

        {useKey ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="analytics-domains">
              {t("mainPanelTabs.analyticsTab.domainsLabel")}
            </Label>
            <Input
              id="analytics-domains"
              value={domainsText}
              onChange={(e) => setDomainsText(e.target.value)}
              placeholder={t("mainPanelTabs.analyticsTab.domainsPlaceholder")}
              className="font-mono text-xs"
            />
            <span className="text-xs text-muted-foreground">
              {t("mainPanelTabs.analyticsTab.domainsHint")}
            </span>
          </div>
        ) : (
          !host && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="analytics-host">
                {t("mainPanelTabs.analyticsTab.hostLabel")}
              </Label>
              <Input
                id="analytics-host"
                value={hostOverride}
                onChange={(e) => setHostOverride(e.target.value)}
                placeholder={t("mainPanelTabs.analyticsTab.hostPlaceholder")}
                className="font-mono text-xs"
              />
              <span className="text-xs text-muted-foreground">
                {t("mainPanelTabs.analyticsTab.hostHint")}
              </span>
            </div>
          )
        )}

        <p className="text-xs text-muted-foreground">
          {t("mainPanelTabs.analyticsTab.registerInstallHint")}
        </p>

        <div className="flex justify-end">
          <Button
            onClick={handleRegister}
            disabled={
              registerMutation.isPending ||
              (useKey ? domains.length === 0 : !host && !hostOverride.trim())
            }
          >
            {registerMutation.isPending
              ? t("mainPanelTabs.analyticsTab.enabling")
              : t("mainPanelTabs.analyticsTab.enableAnalytics")}
          </Button>
        </div>
      </div>
    </Card>
  );
}

// --- edit modules / sampling ------------------------------------------------

function EditAnalyticsDialog({
  base,
  orgSlug,
  site,
  config,
  open,
  onOpenChange,
}: {
  base: string;
  orgSlug: string;
  site: string;
  config: SiteConfig;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(
    new Set(config.modules ?? ["core"]),
  );
  const [samplingPct, setSamplingPct] = useState<string>(
    String(Math.round((config.sampling ?? 1) * 100)),
  );
  const [quota, setQuota] = useState<string>(
    typeof config.quota === "number" && config.quota > 0
      ? String(config.quota)
      : "",
  );

  const saveMutation = useMutation({
    mutationFn: (input: {
      modules: string[];
      sampling: number;
      quota?: number;
    }) => mutateJson(`${base}/analytics/config`, "PUT", input),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: KEYS.analyticsStatus(orgSlug, site),
      });
      toast.success(t("mainPanelTabs.analyticsTab.toastCollectionUpdated"));
      onOpenChange(false);
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const toggle = (key: string) => {
    if (key === "core") return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const quotaNum = quota.trim() === "" ? null : Number(quota);
  const quotaError =
    quotaNum !== null && (!Number.isInteger(quotaNum) || quotaNum < 1)
      ? "Quota must be a positive whole number of events."
      : null;
  const quotaCleared =
    quota.trim() === "" && typeof config.quota === "number" && config.quota > 0;

  const handleSave = () => {
    if (quotaError) return;
    const pct = Number(samplingPct);
    const sampling =
      Number.isFinite(pct) && pct > 0 ? Math.min(pct, 100) / 100 : 1;
    saveMutation.mutate({
      modules: [...selected],
      sampling,
      // Set-only: a blank field can't clear an existing cap (the patch can't
      // carry `undefined`), so only send quota when a positive value is set.
      ...(quotaNum !== null ? { quota: quotaNum } : {}),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("mainPanelTabs.analyticsTab.editTitle")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label>{t("mainPanelTabs.analyticsTab.editModules")}</Label>
            <div className="grid grid-cols-1 gap-2">
              {MODULES.map((m) => {
                const locked = m.key === "core";
                const on = locked || selected.has(m.key);
                return (
                  <label
                    key={m.key}
                    className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border px-3 py-2 hover:border-border/70"
                  >
                    <Checkbox
                      checked={on}
                      disabled={locked}
                      onCheckedChange={() => toggle(m.key)}
                    />
                    <span className="text-sm text-foreground">
                      {t(m.labelKey)}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="analytics-sampling">
              {t("mainPanelTabs.analyticsTab.editSampling")}
            </Label>
            <Input
              id="analytics-sampling"
              type="number"
              min={1}
              max={100}
              value={samplingPct}
              onChange={(e) => setSamplingPct(e.target.value)}
              className="font-mono text-xs"
            />
            <span className="text-xs text-muted-foreground">
              {t("mainPanelTabs.analyticsTab.editSamplingHint")}
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="analytics-quota">Monthly quota</Label>
            <Input
              id="analytics-quota"
              type="number"
              min={1}
              value={quota}
              placeholder="Uncapped"
              onChange={(e) => setQuota(e.target.value)}
              aria-invalid={quotaError != null}
              className="font-mono text-xs"
            />
            {quotaError ? (
              <span className="text-xs text-destructive">{quotaError}</span>
            ) : quotaCleared ? (
              <span className="text-xs text-amber-600 dark:text-amber-500">
                Leaving this blank keeps the current cap — clearing a quota
                isn't a patch. Unregister + re-register to make it uncapped.
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">
                Accepted events per calendar month. Once the reconciler flags
                the site as over, the collector drops further events. Blank =
                uncapped.
              </span>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={saveMutation.isPending}
          >
            {t("mainPanelTabs.analyticsTab.cancel")}
          </Button>
          <Button
            type="button"
            onClick={handleSave}
            disabled={saveMutation.isPending || quotaError != null}
          >
            {saveMutation.isPending
              ? t("mainPanelTabs.analyticsTab.saving")
              : t("mainPanelTabs.analyticsTab.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- configuration (registered site lifecycle) ------------------------------

/** The lifecycle controls for a registered site: state badge + host + id +
 *  modules, pause/resume/edit/unregister, and the tracking summary. Rendered
 *  inside the collapsible Configuration section. */
function ConfigurationPanel({
  base,
  orgSlug,
  site,
  status,
}: {
  base: string;
  orgSlug: string;
  site: string;
  status: AnalyticsStatus;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const cfg = status.config ?? {};
  const enabled = cfg.enabled !== false;
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [rotated, setRotated] = useState<AnalyticsRegisterResult | null>(null);
  // A token exists only for a keyed site (host sites are injected). Keyed sites
  // carry their Origin allowlist in `domains`, so that's the tell.
  const isKeyed = (cfg.domains?.length ?? 0) > 0;

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: KEYS.analyticsStatus(orgSlug, site),
    });

  const rotateMutation = useMutation<AnalyticsRegisterResult, Error, void>({
    mutationFn: () =>
      mutateJson(
        `${base}/analytics/rotate-key`,
        "POST",
      ) as Promise<AnalyticsRegisterResult>,
    onSuccess: (data) => {
      invalidate();
      setRotated(data);
      toast.success(t("mainPanelTabs.analyticsTab.toastTokenRotated"));
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const toggleMutation = useMutation({
    mutationFn: (nextEnabled: boolean) =>
      mutateJson(`${base}/analytics/disable`, "PUT", { enabled: nextEnabled }),
    onSuccess: () => {
      invalidate();
      toast.success(t("mainPanelTabs.analyticsTab.toastCollectionUpdated"));
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: () => mutateJson(`${base}/analytics`, "DELETE"),
    onSuccess: () => {
      invalidate();
      toast.success(t("mainPanelTabs.analyticsTab.toastUnregistered"));
      setDeleteOpen(false);
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const modules = cfg.modules ?? ["core"];

  return (
    <div className="flex flex-col gap-6">
      {rotated && (
        <RegistrationResult
          result={rotated}
          onDismiss={() => setRotated(null)}
        />
      )}
      <Card
        title={t("mainPanelTabs.analyticsTab.collection")}
        action={
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant={enabled ? "outline" : "default"}
              disabled={toggleMutation.isPending}
              onClick={() => toggleMutation.mutate(!enabled)}
            >
              <Power03 className="size-4" />
              {enabled
                ? t("mainPanelTabs.analyticsTab.pause")
                : t("mainPanelTabs.analyticsTab.resume")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditOpen(true)}>
              <Pencil01 className="size-4" />
              {t("mainPanelTabs.analyticsTab.edit")}
            </Button>
            {isKeyed && (
              <Button
                size="sm"
                variant="ghost"
                disabled={rotateMutation.isPending}
                onClick={() => rotateMutation.mutate()}
              >
                <Copy01 className="size-4" />
                {rotateMutation.isPending ? "Rotating…" : "Rotate token"}
              </Button>
            )}
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t("mainPanelTabs.analyticsTab.unregister")}
              className="text-muted-foreground hover:text-destructive"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash01 className="size-4" />
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={enabled ? "success" : "outline"}>
              {enabled
                ? t("mainPanelTabs.analyticsTab.active")
                : t("mainPanelTabs.analyticsTab.paused")}
            </Badge>
            <span className="text-sm text-muted-foreground">
              {t("mainPanelTabs.analyticsTab.collectingUnder", {
                host: status.host ?? "—",
              })}
            </span>
            {cfg.id && (
              <span className="font-mono text-xs text-muted-foreground/80">
                {t("mainPanelTabs.analyticsTab.idLabel", { id: cfg.id })}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {modules.map((m) => (
              <Badge key={m} variant="secondary">
                {m}
              </Badge>
            ))}
            {typeof cfg.sampling === "number" && cfg.sampling < 1 && (
              <Badge variant="outline">
                {t("mainPanelTabs.analyticsTab.sampling", {
                  percent: String(Math.round(cfg.sampling * 100)),
                })}
              </Badge>
            )}
          </div>
        </div>
      </Card>

      <InstallPanel status={status} />

      <EditAnalyticsDialog
        base={base}
        orgSlug={orgSlug}
        site={site}
        config={cfg}
        open={editOpen}
        onOpenChange={setEditOpen}
      />

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("mainPanelTabs.analyticsTab.unregisterTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("mainPanelTabs.analyticsTab.unregisterDescription", {
                site,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              {t("mainPanelTabs.analyticsTab.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                deleteMutation.mutate();
              }}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending
                ? t("mainPanelTabs.analyticsTab.unregistering")
                : t("mainPanelTabs.analyticsTab.unregister")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// --- registered shell: dashboard + configuration ----------------------------

function RegisteredView({
  base,
  orgSlug,
  site,
  status,
}: {
  base: string;
  orgSlug: string;
  site: string;
  status: AnalyticsStatus;
}) {
  const t = useT();
  const [range, setRange] = useState("24h");
  const [active, setActive] = useState("overview");
  const [configOpen, setConfigOpen] = useState(false);
  const cfg = status.config ?? {};
  const enabled = cfg.enabled !== false;
  const modules = cfg.modules ?? ["core"];
  const isLive = active === "live";

  return (
    <div className="flex flex-col gap-5">
      {/* Status + collecting labels on the left, range pills + a small Configure
          button on the right — the dashboard is the focus; settings hide behind
          the gear. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={enabled ? "success" : "outline"}>
              {enabled
                ? t("mainPanelTabs.analyticsTab.active")
                : t("mainPanelTabs.analyticsTab.paused")}
            </Badge>
            <span className="text-sm text-muted-foreground">
              {t("mainPanelTabs.analyticsTab.collectingUnder", {
                host: status.host ?? cfg.id ?? "—",
              })}
            </span>
            {cfg.id && (
              <span className="font-mono text-xs text-muted-foreground/70">
                {t("mainPanelTabs.analyticsTab.idLabel", { id: cfg.id })}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {modules.map((m) => (
              <Badge key={m} variant="secondary">
                {m}
              </Badge>
            ))}
            {typeof cfg.sampling === "number" && cfg.sampling < 1 && (
              <Badge variant="outline">
                {t("mainPanelTabs.analyticsTab.sampling", {
                  percent: String(Math.round(cfg.sampling * 100)),
                })}
              </Badge>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Range pills — hidden on Realtime, which is always "now". */}
          {!isLive && (
            <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
              {RANGE_PILLS.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRange(r)}
                  className={cn(
                    "rounded-md px-2 py-1 text-xs font-medium tabular-nums transition-colors",
                    range === r
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {r}
                </button>
              ))}
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfigOpen(true)}
          >
            <Settings01 className="size-4" />
            {t("mainPanelTabs.analyticsTab.configSectionTitle")}
          </Button>
        </div>
      </div>

      {/* Horizontal view tab bar — one view at a time, like the admin monitor. */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-border">
        {DATA_VIEWS.map((v) => (
          <button
            key={v.view}
            type="button"
            onClick={() => setActive(v.view)}
            className={cn(
              "shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              active === v.view
                ? "border-[var(--chart-1)] text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {v.label}
          </button>
        ))}
      </div>

      <ActiveView
        key={active}
        base={base}
        orgSlug={orgSlug}
        site={site}
        view={active}
        range={range}
        quota={cfg.quota}
      />

      {/* A naturally-closed row documenting the client API, mirroring the admin
          UI's install text — collapsed by default so it doesn't crowd the data. */}
      <details className="group rounded-xl border border-border bg-card">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-foreground hover:bg-muted/40">
          <ChevronRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
          Send custom events from your code
        </summary>
        <div className="flex flex-col gap-3 border-t border-border px-4 py-4 text-sm text-muted-foreground">
          <p>
            Analytics is active automatically — pageviews are collected with no
            code. For custom events, call the public client API on{" "}
            <span className="font-mono text-foreground">window.__dq</span>:
          </p>
          <dl className="flex flex-col gap-2">
            <div className="flex flex-col gap-0.5">
              <dt className="font-mono text-xs text-foreground">pageview()</dt>
              <dd className="text-xs">
                Record a pageview manually (SPA route change).
              </dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="font-mono text-xs text-foreground">
                track(name, props?)
              </dt>
              <dd className="text-xs">
                A custom event. <span className="font-mono">name</span> is
                lowercase a–z, digits and underscore, up to 40 characters;{" "}
                <span className="font-mono">props</span> is an optional flat
                object.
              </dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="font-mono text-xs text-foreground">
                purchase(&#123; transactionId, value, currency, items, itemIds
                &#125;)
              </dt>
              <dd className="text-xs">
                A purchase. <span className="font-mono">transactionId</span>{" "}
                dedupes a reloaded confirmation page so a sale isn't counted
                twice.
              </dd>
            </div>
          </dl>
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
            <code className="whitespace-pre-wrap break-all text-xs text-muted-foreground">
              {
                'window.__dq.track("newsletter_signup", { plan: "pro" })\nwindow.__dq.purchase({ transactionId: "A123", value: 99.9, currency: "BRL" })'
              }
            </code>
          </div>
        </div>
      </details>

      <Dialog open={configOpen} onOpenChange={setConfigOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {t("mainPanelTabs.analyticsTab.configSectionTitle")}
            </DialogTitle>
          </DialogHeader>
          <ConfigurationPanel
            base={base}
            orgSlug={orgSlug}
            site={site}
            status={status}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

// --- tab --------------------------------------------------------------------

export function AnalyticsTab({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const { org } = useProjectContext();
  const entity = useVirtualMCP(virtualMcpId);
  const siteSlug = resolveAgentSiteSlug(entity);
  const enabled = Boolean(siteSlug);
  const base = siteSlug
    ? `/api/${org.slug}/hosting/${encodeURIComponent(siteSlug)}`
    : "";

  const statusQuery = useQuery({
    queryKey: KEYS.analyticsStatus(org.slug, siteSlug ?? ""),
    queryFn: () => fetchJson(`${base}/analytics/status`),
    enabled,
    retry: false,
    staleTime: 30_000,
  });

  // The one-time registration result (snippet/notes, and the token for a keyed
  // site). Held here so it survives the flip to the registered view — a token
  // shown once must not vanish when the register card unmounts.
  const [registered, setRegistered] = useState<AnalyticsRegisterResult | null>(
    null,
  );

  if (!siteSlug) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <EmptyState
          icon={<BarChartSquare02 className="size-5" />}
          title={t("mainPanelTabs.analyticsTab.noSiteTitle")}
          description={t("mainPanelTabs.analyticsTab.noSiteDescription")}
        />
      </div>
    );
  }

  // Pre-token / not-connected: the proxy answers 401 → one calm configuration
  // state instead of a red error.
  if (isUnauthorized(statusQuery.error)) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <EmptyState
          icon={<BarChartSquare02 className="size-5" />}
          title={t("mainPanelTabs.analyticsTab.notConnectedTitle")}
          description={t("mainPanelTabs.analyticsTab.notConnectedDescription")}
        />
      </div>
    );
  }

  const status = (statusQuery.data ?? {}) as AnalyticsStatus;

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 p-6">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <BarChartSquare02 className="size-[18px] text-muted-foreground" />
            <h2 className="text-base font-semibold text-foreground">
              {t("mainPanelTabs.analyticsTab.title")}
            </h2>
          </div>
          <p className="text-sm text-muted-foreground">
            {t("mainPanelTabs.analyticsTab.subtitle", { site: siteSlug })}
          </p>
        </div>

        {registered && (
          <RegistrationResult
            result={registered}
            onDismiss={() => setRegistered(null)}
          />
        )}

        {statusQuery.isLoading ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : statusQuery.error ? (
          isNotConfigured(statusQuery.error) ? (
            // A 503 "not configured" is a deployment state, not a load failure —
            // show the backend-not-configured copy, matching the `configured:false`
            // branch below.
            <EmptyState
              icon={<BarChartSquare02 className="size-5" />}
              title={t("mainPanelTabs.analyticsTab.backendNotConfiguredTitle")}
              description={t(
                "mainPanelTabs.analyticsTab.backendNotConfiguredDescription",
              )}
            />
          ) : (
            <EmptyState
              icon={<BarChartSquare02 className="size-5" />}
              title={t("mainPanelTabs.analyticsTab.statusError")}
            />
          )
        ) : status.configured === false ? (
          <EmptyState
            icon={<BarChartSquare02 className="size-5" />}
            title={t("mainPanelTabs.analyticsTab.backendNotConfiguredTitle")}
            description={t(
              "mainPanelTabs.analyticsTab.backendNotConfiguredDescription",
            )}
          />
        ) : status.registered ? (
          <RegisteredView
            base={base}
            orgSlug={org.slug}
            site={siteSlug}
            status={status}
          />
        ) : (
          <RegisterCard
            base={base}
            orgSlug={org.slug}
            site={siteSlug}
            host={status.host ?? null}
            onRegistered={setRegistered}
          />
        )}
      </div>
    </div>
  );
}
