/**
 * CdnTab (displayed as "Monitor") — per-site CDN + audience analytics,
 * tenant-scoped.
 *
 * The native, first-class replacement for the old deco.cx admin "Monitor"
 * surface (previously embedded as an MCP-UI iframe). It mirrors that surface's
 * two sub-tabs:
 *   - Performance — CDN / edge facts (requests, pageviews, bandwidth, cache,
 *     status codes, top paths/countries) from the stats-lake `fact_usage_*` and
 *     `fact_analytics_*` views.
 *   - Audience — pageviews / visitors / sessions and their breakdowns from
 *     `fact_analytics_daily_view` — the native replacement for the old admin's
 *     OneDollarStats widget.
 *
 * Both halves read through the BFF at `/api/:org/monitor/:site/{cdn|audience}/
 * data?view=&range=`, which resolves the site_id from a slug the org owns and
 * never lets one tenant read another's numbers. No control-plane, no Supabase,
 * no upstream token in the browser.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Globe01 } from "@untitledui/icons";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@decocms/ui/components/chart.tsx";
import { Area, AreaChart, CartesianGrid, Line, XAxis, YAxis } from "recharts";
import { geoMercator, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { FeatureCollection, Geometry } from "geojson";
import worldAtlas from "world-atlas/countries-110m.json";
import isoCountries from "i18n-iso-countries";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useProjectContext, useVirtualMCP } from "@/sdk";
import { resolveAgentSiteSlug } from "@decocms/shared/site-slug";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";
import { Main } from "@/components/main";

// Date presets, in display order. The CDN warehouse is DATE-granular (facts are
// keyed by a `date` column, no timestamp), so sub-day presets (60m/24h/48h/72h)
// were dropped: they can't be honored and only rendered a misleading rolling
// window. `today`/`yesterday` are exact calendar days; the rest are inclusive
// N-day windows ending today (see monitor.ts resolveWindow).
const RANGE_PRESETS = [
  { key: "today", label: "today" },
  { key: "yesterday", label: "yesterday" },
  { key: "7d", label: "last7d" },
  { key: "14d", label: "last14d" },
  { key: "30d", label: "last30d" },
  { key: "90d", label: "last90d" },
  { key: "180d", label: "last180d" },
  { key: "1y", label: "lastYear" },
] as const;

interface RangeSel {
  range: string;
  since: string;
  until: string;
  compare: boolean;
}

/** The date-range dropdown: presets + a custom range + a Compare toggle. */
function RangePicker({
  value,
  onChange,
}: {
  value: RangeSel;
  onChange: (v: RangeSel) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [cs, setCs] = useState(value.since);
  const [cu, setCu] = useState(value.until);
  const label =
    value.range === "custom"
      ? `${value.since} → ${value.until}`
      : t(
          `mainPanelTabs.cdnTab.${
            RANGE_PRESETS.find((p) => p.key === value.range)?.label ?? "last7d"
          }` as never,
        );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground"
        >
          {label}
          {value.compare && (
            <span className="text-muted-foreground">
              · {t("mainPanelTabs.cdnTab.compare")}
            </span>
          )}
          <span className="text-muted-foreground">▾</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <div className="grid grid-cols-2 gap-1">
          {RANGE_PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => {
                onChange({ ...value, range: p.key });
                setOpen(false);
              }}
              className={cn(
                "rounded-md px-2 py-1 text-left text-xs transition-colors",
                value.range === p.key
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(`mainPanelTabs.cdnTab.${p.label}` as never)}
            </button>
          ))}
        </div>
        <div className="mt-2 flex flex-col gap-2 border-t border-border pt-2">
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={cs}
              onChange={(e) => setCs(e.target.value)}
              className="min-w-0 flex-1 rounded-md border border-border bg-card px-2 py-1 text-xs"
            />
            <span className="text-muted-foreground">–</span>
            <input
              type="date"
              value={cu}
              onChange={(e) => setCu(e.target.value)}
              className="min-w-0 flex-1 rounded-md border border-border bg-card px-2 py-1 text-xs"
            />
            <button
              type="button"
              // Also block an inverted range (start after end) — otherwise Apply
              // submits it and the dashboard silently shows no data.
              disabled={!cs || !cu || cs > cu}
              onClick={() => {
                onChange({ ...value, range: "custom", since: cs, until: cu });
                setOpen(false);
              }}
              className="rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background disabled:opacity-40"
            >
              {t("mainPanelTabs.cdnTab.apply")}
            </button>
          </div>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={value.compare}
              onChange={(e) =>
                onChange({ ...value, compare: e.target.checked })
              }
              className="size-3.5 accent-foreground"
            />
            {t("mainPanelTabs.cdnTab.compare")}
          </label>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Series colors, matching the old admin: requests blue, pageviews green,
// bandwidth orange. Uses the theme's chart tokens so it reads in light + dark.
const COLOR_REQUESTS = "var(--chart-1)";
const COLOR_PAGEVIEWS = "var(--chart-2)";
const COLOR_BANDWIDTH = "var(--chart-4)";

function formatNumber(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat().format(n);
}

/** Compact number for chart axes / large counts: 2.5M, 63.1M, 1.2K. */
function formatCompact(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
}

/** Bytes → a compact human unit (B / KB / MB / GB / TB). */
function formatBytes(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(
    Math.floor(Math.log(n) / Math.log(1024)),
    units.length - 1,
  );
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatPct(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(1)}%`;
}

/** The viewer's UTC offset as "GMT-3" — the timezone charts are read in. */
function gmtLabel(): string {
  const off = -Math.round(new Date().getTimezoneOffset() / 60);
  return `GMT${off >= 0 ? "+" : ""}${off}`;
}

// Cache-status and HTTP status dot colors, plus friendly status-code names.
const CACHE_COLORS: Record<string, string> = {
  hit: "bg-emerald-500",
  dynamic: "bg-blue-500",
  bypass: "bg-violet-500",
  miss: "bg-amber-500",
  expired: "bg-orange-500",
  stale: "bg-yellow-500",
  revalidated: "bg-teal-500",
  updating: "bg-slate-400",
  none: "bg-muted-foreground",
};
function cacheColor(k: string): string {
  return CACHE_COLORS[k.toLowerCase()] ?? "bg-muted-foreground";
}
function statusColor(code: string): string {
  const n = Number(code);
  if (n >= 200 && n < 300) return "bg-emerald-500";
  if (n >= 300 && n < 400) return "bg-blue-500";
  if (n >= 400 && n < 500) return "bg-amber-500";
  if (n >= 500) return "bg-red-500";
  return "bg-muted-foreground";
}
const STATUS_NAMES: Record<string, string> = {
  "200": "200 OK",
  "201": "201 Created",
  "204": "204 No Content",
  "206": "206 Partial Content",
  "301": "301 Moved Permanently",
  "302": "302 Found",
  "304": "304 Not Modified",
  "307": "307 Temporary Redirect",
  "308": "308 Permanent Redirect",
  "400": "400 Bad Request",
  "401": "401 Unauthorized",
  "403": "403 Forbidden",
  "404": "404 Not Found",
  "410": "410 Gone",
  "429": "429 Too Many Requests",
  "499": "499 Client Closed Request",
  "500": "500 Internal Server Error",
  "502": "502 Bad Gateway",
  "503": "503 Service Unavailable",
  "504": "504 Gateway Timeout",
};
function statusName(code: string): string {
  return STATUS_NAMES[code] ?? code;
}
// A stable palette for dimensionless breakdowns (sources / devices).
const PALETTE = [
  "bg-blue-500",
  "bg-emerald-500",
  "bg-violet-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-teal-500",
  "bg-orange-500",
  "bg-slate-400",
];

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

interface CdnSummary {
  total_requests: number;
  total_bandwidth_bytes: number;
  cache_hit_ratio: number;
  avg_latency_ms: number;
  status_2xx_count: number;
  status_4xx_count: number;
  status_5xx_count: number;
  unique_countries: number;
  pageviews: number;
}
interface TimelinePoint {
  bucket: string;
  requests: number;
  bandwidth_bytes: number;
  pageviews: number;
  cache_hit_ratio: number;
}
interface BreakdownRow {
  key: string;
  total_requests: number;
  total_bandwidth_bytes: number;
}
/** One monitor view (cdn or audience) for the current range. */
function useMonitorView<T>(
  base: string,
  kind: "cdn" | "audience",
  view: string,
  range: string,
  enabled: boolean,
  extra?: string,
) {
  return useQuery({
    queryKey: KEYS.cdnData(base, `${kind}:${view}${extra ?? ""}`, range),
    queryFn: async () => {
      const body = (await fetchJson(
        `${base}/${kind}/data?view=${view}&range=${range}${extra ?? ""}`,
      )) as { available?: boolean; data?: T };
      if (body.available === false) return null;
      return (body.data ?? null) as T | null;
    },
    enabled,
    retry: false,
    staleTime: 30_000,
  });
}

/** ISO 3166-1 alpha-2 → localized country name (e.g. "BR" → "Brazil"), so the
 *  breakdowns read like the old admin rather than showing raw codes. */
const REGION_NAMES = (() => {
  try {
    return new Intl.DisplayNames(undefined, { type: "region" });
  } catch {
    return null;
  }
})();
function formatCountry(code: string): string {
  if (!code) return "—";
  const up = code.toUpperCase();
  if (up.length !== 2) return code;
  try {
    return REGION_NAMES?.of(up) ?? code;
  } catch {
    return code;
  }
}

function Card({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <header className="flex items-start gap-2 px-4 py-3 border-b border-border">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          {subtitle && (
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          )}
        </div>
        {action && <div className="ml-auto shrink-0">{action}</div>}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
        {value}
      </div>
    </div>
  );
}

interface RankItem {
  label: string;
  color: string;
  value: number;
  formatted: string;
}

/** A ranked list: colored dot + label, value, and a share bar — the old admin's
 *  Cache Status / Status Codes / breakdown layout. */
const RANKED_COLLAPSED = 10;

function RankedList({
  items,
  emptyLabel,
}: {
  items: RankItem[];
  emptyLabel: string;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }
  // Shares/bars scale over the full set; only the visible slice is rendered.
  const total = items.reduce((s, i) => s + i.value, 0) || 1;
  const max = Math.max(...items.map((i) => i.value), 1);
  const visible = expanded ? items : items.slice(0, RANKED_COLLAPSED);
  const hasMore = items.length > RANKED_COLLAPSED;
  return (
    <div className="flex flex-col">
      <div className="flex flex-col divide-y divide-border/60">
        {visible.map((it) => (
          <div key={it.label} className="flex items-center gap-3 py-2">
            <span className={cn("size-2 shrink-0 rounded-full", it.color)} />
            <span
              className="min-w-0 flex-1 truncate text-sm text-foreground"
              title={it.label}
            >
              {it.label || "—"}
            </span>
            <span className="w-10 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
              {Math.round((it.value / total) * 100)}%
            </span>
            <span className="w-24 shrink-0 text-right text-sm tabular-nums">
              {it.formatted}
            </span>
            <div className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-muted">
              <div
                className={cn("h-full rounded-full", it.color)}
                style={{ width: `${Math.max((it.value / max) * 100, 2)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      {hasMore && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 self-start text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          {expanded
            ? t("mainPanelTabs.cdnTab.showLess")
            : t("mainPanelTabs.cdnTab.showAll").replace(
                "{count}",
                String(items.length),
              )}
        </button>
      )}
    </div>
  );
}

// World country polygons, BUNDLED (not fetched from a CDN at render, which would
// silently render an empty map when the CDN is blocked/offline). The topojson is
// keyed by numeric ISO id, converted once to GeoJSON features at module load.
// world-atlas ships a topojson `Topology`; `topojson-client.feature` turns the
// `countries` GeometryCollection into GeoJSON. The topojson-specification types
// don't narrow cleanly through the .json import, so the args/return are asserted
// via `unknown` — the runtime shape is guaranteed by the pinned `world-atlas`.
const worldTopology = worldAtlas as unknown as {
  objects: { countries: object };
};
const WORLD_FEATURES = (
  feature(
    worldTopology as never,
    worldTopology.objects.countries as never,
  ) as unknown as FeatureCollection<Geometry, { name?: string }>
).features;

// Rectangular Mercator (like the OneDollar map), cropped below Antarctica and
// above the Arctic so the world fills the 800×520 card without distortion.
// Translate to the viewbox centre matches react-simple-maps' old default.
const MAP_PROJECTION = geoMercator()
  .scale(120)
  .center([0, 42])
  .translate([400, 260]);
const MAP_PATH = geoPath(MAP_PROJECTION);

/** Choropleth of a country breakdown — the Map view of the Countries panel.
 *  The topojson keys countries by numeric ISO id; convert it to alpha-2
 *  (i18n-iso-countries) to join the alpha-2 breakdown data. */
function CountryMap({ rows }: { rows: { key: string; value: number }[] }) {
  const t = useT();
  const byCode = new Map<string, number>();
  for (const r of rows) if (r.key) byCode.set(r.key.toUpperCase(), r.value);
  const max = Math.max(1, ...rows.map((r) => r.value));
  const [tip, setTip] = useState<{
    name: string;
    value: number;
    x: number;
    y: number;
  } | null>(null);
  // Accessible name + a short spoken summary of the leading countries, so the
  // choropleth isn't just an unlabeled graphic to a screen reader.
  const summary = rows
    .slice(0, 5)
    .filter((r) => r.key)
    .map((r) => `${formatCountry(r.key)}: ${formatNumber(r.value)}`)
    .join(", ");
  const mapLabel = t("mainPanelTabs.cdnTab.countryMapLabel");
  return (
    <div className="relative w-full" onMouseLeave={() => setTip(null)}>
      <svg
        viewBox="0 0 800 520"
        style={{ width: "100%", height: "auto" }}
        role="img"
        aria-label={summary ? `${mapLabel} — ${summary}` : mapLabel}
      >
        {WORLD_FEATURES.map((geo, i) => {
          const id = String(geo.id ?? "").padStart(3, "0");
          const a2 = isoCountries.numericToAlpha2(id);
          const value = (a2 && byCode.get(a2.toUpperCase())) || 0;
          const ratio = value / max;
          const name = geo.properties?.name ?? (a2 ? formatCountry(a2) : id);
          const d = MAP_PATH(geo);
          if (!d) return null;
          return (
            <path
              key={geo.id != null ? String(geo.id) : i}
              d={d}
              className="cursor-pointer outline-none hover:opacity-80"
              onMouseMove={(e: React.MouseEvent) => {
                const box = (
                  e.currentTarget as SVGElement
                ).ownerSVGElement?.parentElement?.getBoundingClientRect();
                setTip({
                  name,
                  value,
                  x: box ? e.clientX - box.left : 0,
                  y: box ? e.clientY - box.top : 0,
                });
              }}
              onMouseLeave={() => setTip(null)}
              fill={
                value > 0
                  ? `color-mix(in oklch, var(--chart-2) ${Math.round(
                      18 + ratio * 82,
                    )}%, transparent)`
                  : "var(--muted)"
              }
              stroke="var(--border)"
              strokeWidth={0.3}
            />
          );
        })}
      </svg>
      {tip && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border border-border bg-popover px-2 py-1 text-xs shadow-md"
          style={{ left: tip.x + 10, top: tip.y + 10 }}
        >
          <span className="text-foreground">{tip.name}</span>
          <span className="ml-1.5 tabular-nums text-muted-foreground">
            {formatNumber(tip.value)}
          </span>
        </div>
      )}
    </div>
  );
}

// --- Filter builder (field / operator / value — the admin's "Add filter") ----

interface MonitorFilter {
  field: string;
  op: "equals" | "not_equals" | "contains" | "not_contains";
  value: string;
}

const FILTER_OPS: MonitorFilter["op"][] = [
  "equals",
  "not_equals",
  "contains",
  "not_contains",
];

const CDN_FILTER_FIELDS = [
  { value: "cache_status", key: "cacheStatus" },
  { value: "status_code", key: "code" },
  { value: "path", key: "path" },
  { value: "country", key: "country" },
] as const;

const OD_FILTER_FIELDS = [
  { value: "page", key: "page" },
  { value: "source", key: "referrer" },
  { value: "country", key: "country" },
  { value: "browser", key: "browser" },
  { value: "os", key: "os" },
  { value: "device", key: "device" },
  { value: "utm_campaign", key: "utm_campaign" },
  { value: "utm_source", key: "utm_source" },
  { value: "utm_medium", key: "utm_medium" },
  { value: "utm_content", key: "utm_content" },
] as const;

/** Fields with a known, finite value set render a Select instead of a free
 *  input (matching the admin's value dropdown). */
const FIELD_OPTIONS: Record<string, string[]> = {
  cache_status: [
    "hit",
    "miss",
    "dynamic",
    "bypass",
    "expired",
    "stale",
    "revalidated",
    "updating",
    "none",
  ],
  device: ["Desktop", "Mobile", "Tablet"],
};

/** Serialize filters for the `&filters=` query param (empty ⇒ ""). */
function filtersParam(filters: MonitorFilter[]): string {
  return filters.length
    ? `&filters=${encodeURIComponent(JSON.stringify(filters))}`
    : "";
}

/**
 * The "Add filter" row + active-filter chips, shared by both sub-tabs. Matches
 * the admin: a field select, an operator select, a value input, then
 * Cancel/Apply; applied filters render as removable chips.
 */
function FilterBar({
  fields,
  filters,
  onChange,
}: {
  fields: readonly { value: string; key: string }[];
  filters: MonitorFilter[];
  onChange: (next: MonitorFilter[]) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<MonitorFilter | null>(null);
  const selectCls =
    "rounded-lg border border-border bg-card px-2 py-1 text-xs text-foreground";
  const opLabel = (op: string) => t(`mainPanelTabs.cdnTab.op_${op}` as never);
  const fieldLabel = (v: string) =>
    t(
      `mainPanelTabs.cdnTab.${fields.find((f) => f.value === v)?.key ?? v}` as never,
    );

  return (
    <div className="flex flex-wrap items-center gap-2">
      {filters.map((f, i) => (
        <span
          key={`${f.field}-${i}`}
          className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-2 py-1 text-xs"
        >
          <span className="text-foreground">
            {fieldLabel(f.field)} {opLabel(f.op)}{" "}
            <span className="font-medium">{f.value}</span>
          </span>
          <button
            type="button"
            aria-label={t("mainPanelTabs.cdnTab.removeFilter")}
            onClick={() => onChange(filters.filter((_, j) => j !== i))}
            className="text-muted-foreground hover:text-foreground"
          >
            ×
          </button>
        </span>
      ))}

      {draft ? (
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-card p-1">
          <select
            value={draft.field}
            onChange={(e) => setDraft({ ...draft, field: e.target.value })}
            className={selectCls}
          >
            {fields.map((f) => (
              <option key={f.value} value={f.value}>
                {fieldLabel(f.value)}
              </option>
            ))}
          </select>
          <select
            value={draft.op}
            onChange={(e) =>
              setDraft({ ...draft, op: e.target.value as MonitorFilter["op"] })
            }
            className={selectCls}
          >
            {FILTER_OPS.map((op) => (
              <option key={op} value={op}>
                {opLabel(op)}
              </option>
            ))}
          </select>
          {FIELD_OPTIONS[draft.field] ? (
            <select
              value={draft.value}
              onChange={(e) => setDraft({ ...draft, value: e.target.value })}
              className={selectCls}
            >
              <option value="">{t("mainPanelTabs.cdnTab.filterValue")}</option>
              {FIELD_OPTIONS[draft.field]!.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={draft.value}
              onChange={(e) => setDraft({ ...draft, value: e.target.value })}
              placeholder={t("mainPanelTabs.cdnTab.filterValue")}
              className="rounded-lg border border-border bg-card px-2 py-1 text-xs text-foreground"
            />
          )}
          <button
            type="button"
            onClick={() => setDraft(null)}
            className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {t("mainPanelTabs.cdnTab.cancel")}
          </button>
          <button
            type="button"
            disabled={!draft.value.trim()}
            onClick={() => {
              onChange([...filters, { ...draft, value: draft.value.trim() }]);
              setDraft(null);
            }}
            className="rounded-lg bg-foreground px-2 py-1 text-xs font-medium text-background disabled:opacity-40"
          >
            {t("mainPanelTabs.cdnTab.apply")}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() =>
            setDraft({ field: fields[0]!.value, op: "equals", value: "" })
          }
          className="rounded-lg border border-dashed border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
        >
          + {t("mainPanelTabs.cdnTab.addFilter")}
        </button>
      )}
    </div>
  );
}

/** Performance (CDN / edge) sub-tab. */
function PerformanceSection({
  base,
  range,
  rangeExtra,
  enabled,
}: {
  base: string;
  range: string;
  rangeExtra: string;
  enabled: boolean;
}) {
  const t = useT();
  const [metric, setMetric] = useState<"requests" | "bandwidth">("requests");
  const [ignoreQuery, setIgnoreQuery] = useState(true);
  const [filters, setFilters] = useState<MonitorFilter[]>([]);
  const fp = filtersParam(filters) + rangeExtra;
  const summary = useMonitorView<CdnSummary>(
    base,
    "cdn",
    "summary",
    range,
    enabled,
    fp,
  );
  const timeline = useMonitorView<TimelinePoint[]>(
    base,
    "cdn",
    "timeline",
    range,
    enabled,
    fp,
  );
  const cacheStatus = useMonitorView<BreakdownRow[]>(
    base,
    "cdn",
    "cache-status",
    range,
    enabled,
    fp,
  );
  const statusCodes = useMonitorView<BreakdownRow[]>(
    base,
    "cdn",
    "status-codes",
    range,
    enabled,
    fp,
  );
  const topPaths = useMonitorView<BreakdownRow[]>(
    base,
    "cdn",
    "top-paths",
    range,
    enabled,
    `${ignoreQuery ? "&groupByPath=1" : ""}${fp}`,
  );
  const topCountries = useMonitorView<BreakdownRow[]>(
    base,
    "cdn",
    "top-countries",
    range,
    enabled,
    fp,
  );

  const notConfigured =
    summary.data === null && !summary.isLoading && !summary.isError;
  if (notConfigured) {
    return (
      <EmptyState
        icon={<Globe01 className="size-5" />}
        title={t("mainPanelTabs.cdnTab.unconfiguredTitle")}
        description={t("mainPanelTabs.cdnTab.unconfiguredBody")}
      />
    );
  }
  if (summary.isError) {
    return (
      <EmptyState
        icon={<Globe01 className="size-5" />}
        title={t("mainPanelTabs.cdnTab.errorTitle")}
        description={(summary.error as Error)?.message ?? ""}
      />
    );
  }

  const s = summary.data;
  const reqPerPv = s && s.pageviews > 0 ? s.total_requests / s.pageviews : null;
  const bwPer10kPv =
    s && s.pageviews > 0
      ? s.total_bandwidth_bytes / (s.pageviews / 10000)
      : null;

  const cdnItems = (
    rows: BreakdownRow[] | null | undefined,
    named: boolean,
  ): RankItem[] =>
    (rows ?? []).map((r) => ({
      label: named ? statusName(r.key) : r.key,
      color: named ? statusColor(r.key) : cacheColor(r.key),
      value: metric === "requests" ? r.total_requests : r.total_bandwidth_bytes,
      formatted:
        metric === "requests"
          ? formatNumber(r.total_requests)
          : formatBytes(r.total_bandwidth_bytes),
    }));

  const metricToggle = (
    <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
      {(["requests", "bandwidth"] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => setMetric(m)}
          className={cn(
            "rounded-md px-2 py-0.5 text-xs font-medium transition-colors",
            metric === m
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {m === "requests"
            ? t("mainPanelTabs.cdnTab.requests")
            : t("mainPanelTabs.cdnTab.bandwidth")}
        </button>
      ))}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <FilterBar
        fields={CDN_FILTER_FIELDS}
        filters={filters}
        onChange={setFilters}
      />
      {summary.isLoading || !s ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label={t("mainPanelTabs.cdnTab.requests")}
            value={formatNumber(s.total_requests)}
          />
          <Stat
            label={t("mainPanelTabs.cdnTab.pageviews")}
            value={formatNumber(s.pageviews)}
          />
          <Stat
            label={t("mainPanelTabs.cdnTab.bandwidth")}
            value={formatBytes(s.total_bandwidth_bytes)}
          />
          <Stat
            label={t("mainPanelTabs.cdnTab.cacheHit")}
            value={formatPct(s.cache_hit_ratio)}
          />
          <Stat
            label={t("mainPanelTabs.cdnTab.requestsPerPageview")}
            value={reqPerPv === null ? "—" : reqPerPv.toFixed(1)}
          />
          <Stat
            label={t("mainPanelTabs.cdnTab.bandwidthPer10k")}
            value={bwPer10kPv === null ? "—" : formatBytes(bwPer10kPv)}
          />
          <Stat
            label={t("mainPanelTabs.cdnTab.avgLatency")}
            value={`${Math.round(s.avg_latency_ms)} ms`}
          />
          <Stat
            label={t("mainPanelTabs.cdnTab.errors5xx")}
            value={formatNumber(s.status_5xx_count)}
          />
        </div>
      )}

      <Card
        title={t("mainPanelTabs.cdnTab.usageOverTime")}
        subtitle={t("mainPanelTabs.cdnTab.usageSubtitle")}
      >
        {timeline.isLoading ? (
          <Skeleton className="h-72 w-full" />
        ) : (timeline.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("mainPanelTabs.cdnTab.emptyRange")}
          </p>
        ) : (
          <ChartContainer
            config={{
              requests: {
                label: t("mainPanelTabs.cdnTab.requests"),
                color: COLOR_REQUESTS,
              },
              pageviews: {
                label: t("mainPanelTabs.cdnTab.pageviews"),
                color: COLOR_PAGEVIEWS,
              },
              bandwidth_bytes: {
                label: t("mainPanelTabs.cdnTab.bandwidth"),
                color: COLOR_BANDWIDTH,
              },
            }}
            className="h-72 w-full"
          >
            <AreaChart
              data={timeline.data ?? []}
              margin={{ top: 8, right: 8, bottom: 8, left: 0 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="bucket"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={32}
                tickFormatter={(v: string) => String(v).slice(5, 16)}
              />
              <YAxis
                yAxisId="left"
                tickLine={false}
                axisLine={false}
                width={48}
                tickFormatter={(v: number) => formatCompact(v)}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                tickLine={false}
                axisLine={false}
                width={56}
                tickFormatter={(v: number) => formatBytes(v)}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Area
                yAxisId="left"
                dataKey="requests"
                type="monotone"
                fill={COLOR_REQUESTS}
                fillOpacity={0.15}
                stroke={COLOR_REQUESTS}
                strokeWidth={2}
              />
              <Area
                yAxisId="left"
                dataKey="pageviews"
                type="monotone"
                fill={COLOR_PAGEVIEWS}
                fillOpacity={0.12}
                stroke={COLOR_PAGEVIEWS}
                strokeWidth={2}
              />
              <Line
                yAxisId="right"
                dataKey="bandwidth_bytes"
                type="monotone"
                dot={false}
                stroke={COLOR_BANDWIDTH}
                strokeWidth={2}
              />
            </AreaChart>
          </ChartContainer>
        )}
      </Card>

      {/* Shared metric control for ALL breakdown lists below (cache status,
          status codes, top paths, top countries) — placed above the grid so it
          reads as governing every list, not just the first card. */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {t("mainPanelTabs.cdnTab.measureBy")}
        </span>
        {metricToggle}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card
          title={t("mainPanelTabs.cdnTab.cacheStatus")}
          subtitle={t("mainPanelTabs.cdnTab.cacheStatusSubtitle")}
        >
          {cacheStatus.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <RankedList
              items={cdnItems(cacheStatus.data, false)}
              emptyLabel={t("mainPanelTabs.cdnTab.emptyRange")}
            />
          )}
        </Card>
        <Card
          title={t("mainPanelTabs.cdnTab.statusCodes")}
          subtitle={t("mainPanelTabs.cdnTab.statusCodesSubtitle")}
        >
          {statusCodes.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <RankedList
              items={cdnItems(statusCodes.data, true)}
              emptyLabel={t("mainPanelTabs.cdnTab.emptyRange")}
            />
          )}
        </Card>
        <Card
          title={t("mainPanelTabs.cdnTab.topPaths")}
          action={
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={ignoreQuery}
                onChange={(e) => setIgnoreQuery(e.target.checked)}
                className="size-3.5 accent-foreground"
              />
              {t("mainPanelTabs.cdnTab.ignoreQueryString")}
            </label>
          }
        >
          {topPaths.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <RankedList
              items={(topPaths.data ?? []).map((r, i) => ({
                label: r.key,
                color: PALETTE[i % PALETTE.length] ?? "bg-muted-foreground",
                value:
                  metric === "requests"
                    ? r.total_requests
                    : r.total_bandwidth_bytes,
                formatted:
                  metric === "requests"
                    ? formatNumber(r.total_requests)
                    : formatBytes(r.total_bandwidth_bytes),
              }))}
              emptyLabel={t("mainPanelTabs.cdnTab.emptyRange")}
            />
          )}
        </Card>
        <Card title={t("mainPanelTabs.cdnTab.topCountries")}>
          {topCountries.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <RankedList
              items={(topCountries.data ?? []).map((r, i) => ({
                label: formatCountry(r.key),
                color: PALETTE[i % PALETTE.length] ?? "bg-muted-foreground",
                value:
                  metric === "requests"
                    ? r.total_requests
                    : r.total_bandwidth_bytes,
                formatted:
                  metric === "requests"
                    ? formatNumber(r.total_requests)
                    : formatBytes(r.total_bandwidth_bytes),
              }))}
              emptyLabel={t("mainPanelTabs.cdnTab.emptyRange")}
            />
          )}
        </Card>
      </div>
    </div>
  );
}

/** Audience (pageviews / visitors) sub-tab — the native OneDollar replacement. */
interface OdResult {
  dimensions: string[];
  metrics: number[];
}

interface OdPayload {
  results: OdResult[];
  previous?: OdResult[];
}

/** One OneDollarStats (Plausible) report for the current range + host. Returns
 *  the full payload (results, and for kpis the previous-period comparison). */
function useOd(
  base: string,
  report: string,
  range: string,
  host: string,
  enabled: boolean,
  fp = "",
) {
  return useQuery({
    queryKey: KEYS.cdnData(base, `od:${report}:${host}${fp}`, range),
    queryFn: async (): Promise<OdPayload | null> => {
      const hostQ = host ? `&host=${encodeURIComponent(host)}` : "";
      const body = (await fetchJson(
        `${base}/onedollar?report=${report}&range=${range}${hostQ}${fp}`,
      )) as {
        available?: boolean;
        results?: OdResult[];
        previous?: OdResult[];
      };
      if (body.available === false) return null;
      return { results: body.results ?? [], previous: body.previous };
    },
    enabled,
    retry: false,
    staleTime: 30_000,
  });
}

/** Seconds → "12m 3s" / "45s". */
function formatDuration(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return "0s";
  // Round to whole seconds FIRST, then split — otherwise a value that rounds up
  // across a minute boundary (e.g. 119.6) renders "1m 60s".
  const total = Math.round(n);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}

/** Map a breakdown report's rows to RankItems, ranking by a metric index.
 *  `label` transforms the raw dimension (country code → name, null → a friendly
 *  fallback like "Direct/Unknown"). */
function odRankItems(
  rows: OdResult[] | null | undefined,
  metricIndex: number,
  label?: (raw: string) => string,
): RankItem[] {
  return (rows ?? []).map((r, i) => {
    const raw = r.dimensions[0] ?? "";
    return {
      label: label ? label(raw) : raw,
      color: PALETTE[i % PALETTE.length] ?? "bg-muted-foreground",
      value: Number(r.metrics[metricIndex] ?? 0),
      formatted: formatNumber(r.metrics[metricIndex] ?? 0),
    };
  });
}

/** Event / UTM table: label + Unique (visitors) + Total (events), 10-then-more,
 *  with an optional CR column (event unique / total unique). */
function OdMetricTable({
  rows,
  keyHeader,
  totalVisitors,
  emptyLabel,
}: {
  rows: OdResult[] | null | undefined;
  keyHeader: string;
  totalVisitors: number | null;
  emptyLabel: string;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const list = rows ?? [];
  if (list.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }
  const visible = expanded ? list : list.slice(0, RANKED_COLLAPSED);
  const hasMore = list.length > RANKED_COLLAPSED;
  return (
    <div className="flex flex-col">
      <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-4 gap-y-2 text-sm">
        <span className="text-xs text-muted-foreground">{keyHeader}</span>
        <span className="text-right text-xs text-muted-foreground">
          {t("mainPanelTabs.cdnTab.cr")}
        </span>
        <span className="text-right text-xs text-muted-foreground">
          {t("mainPanelTabs.cdnTab.unique")}
        </span>
        <span className="text-right text-xs text-muted-foreground">
          {t("mainPanelTabs.cdnTab.total")}
        </span>
        {visible.map((r) => {
          const unique = Number(r.metrics[0] ?? 0);
          const total = Number(r.metrics[1] ?? 0);
          const cr =
            totalVisitors && totalVisitors > 0
              ? Math.round((unique / totalVisitors) * 100)
              : null;
          return (
            <div key={r.dimensions[0]} className="contents">
              <span
                className="min-w-0 truncate font-mono text-xs text-foreground"
                title={r.dimensions[0]}
              >
                {r.dimensions[0] || "—"}
              </span>
              <span className="text-right tabular-nums text-muted-foreground">
                {cr === null ? "—" : `${cr}%`}
              </span>
              <span className="text-right tabular-nums">
                {formatNumber(unique)}
              </span>
              <span className="text-right tabular-nums">
                {formatNumber(total)}
              </span>
            </div>
          );
        })}
      </div>
      {hasMore && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 self-start text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          {expanded
            ? t("mainPanelTabs.cdnTab.showLess")
            : t("mainPanelTabs.cdnTab.showAll").replace(
                "{count}",
                String(list.length),
              )}
        </button>
      )}
    </div>
  );
}

const DEVICE_DIMS = ["browsers", "os", "devices"] as const;
const UTM_DIMS = [
  "utm_campaign",
  "utm_source",
  "utm_medium",
  "utm_content",
  "utm_term",
] as const;

/**
 * Audience sub-tab — the old admin's OneDollarStats "Analytics" dashboard,
 * rendered natively from the Plausible-compatible API (proxied by the BFF so the
 * key stays server-side). Interim source until Deco Analytics covers these
 * dimensions; the front reads normalized rows and is source-agnostic.
 */
// KPI cards: which kpis-metric index each reads, which timeseries-metric index
// plots it, how to format it, and whether higher is better (for delta color).
const KPI_DEFS = [
  {
    key: "pageviews",
    label: "pageviews",
    kpiIdx: 2,
    tsIdx: 0,
    fmt: "num",
    up: true,
  },
  { key: "visits", label: "visits", kpiIdx: 1, tsIdx: 1, fmt: "num", up: true },
  {
    key: "visitors",
    label: "visitors",
    kpiIdx: 0,
    tsIdx: 2,
    fmt: "num",
    up: true,
  },
  {
    key: "duration",
    label: "visitDuration",
    kpiIdx: 4,
    tsIdx: 4,
    fmt: "dur",
    up: true,
  },
  {
    key: "bounce",
    label: "bounceRate",
    kpiIdx: 3,
    tsIdx: 3,
    fmt: "pct",
    up: false,
  },
] as const;

function fmtKpi(fmt: string, v: number): string {
  if (fmt === "dur") return formatDuration(v);
  if (fmt === "pct") return `${Math.round(v)}%`;
  return formatNumber(v);
}

function useOdHosts(base: string, enabled: boolean) {
  return useQuery({
    queryKey: KEYS.cdnData(base, "od:hosts", "all"),
    queryFn: async (): Promise<string[]> => {
      const body = (await fetchJson(`${base}/hosts`)) as {
        available?: boolean;
        hosts?: string[];
      };
      return body.hosts ?? [];
    },
    enabled,
    retry: false,
    staleTime: 300_000,
  });
}

/**
 * Analytics sub-tab — the old admin's OneDollarStats dashboard, rendered
 * natively from the Plausible-compatible API (proxied by the BFF so the key
 * stays server-side). Interim source until Deco Analytics covers these
 * dimensions; the front reads normalized rows and is source-agnostic.
 */
function AudienceSection({
  base,
  range,
  rangeExtra,
  compare,
  enabled,
}: {
  base: string;
  range: string;
  rangeExtra: string;
  compare: boolean;
  enabled: boolean;
}) {
  const t = useT();
  const [deviceDim, setDeviceDim] =
    useState<(typeof DEVICE_DIMS)[number]>("browsers");
  const [utmDim, setUtmDim] =
    useState<(typeof UTM_DIMS)[number]>("utm_campaign");
  const [plotted, setPlotted] =
    useState<(typeof KPI_DEFS)[number]["key"]>("pageviews");
  const [countryView, setCountryView] = useState<"map" | "list">("map");
  const [selectedHost, setSelectedHost] = useState("");
  const [filters, setFilters] = useState<MonitorFilter[]>([]);
  const fp = filtersParam(filters) + rangeExtra + (compare ? "&compare=1" : "");

  const hostsQuery = useOdHosts(base, enabled);
  // Empty string ⇒ BFF picks the busiest host; once hosts load, default to the
  // first (production) unless the user picked one.
  const host = selectedHost || hostsQuery.data?.[0] || "";

  const kpis = useOd(base, "kpis", range, host, enabled, fp);
  const timeseries = useOd(base, "timeseries", range, host, enabled, fp);
  const pages = useOd(base, "pages", range, host, enabled, fp);
  const sources = useOd(base, "sources", range, host, enabled, fp);
  const countries = useOd(base, "countries", range, host, enabled, fp);
  const deviceRows = useOd(base, deviceDim, range, host, enabled, fp);
  const events = useOd(base, "events", range, host, enabled, fp);
  const utm = useOd(base, utmDim, range, host, enabled, fp);

  const notConfigured = kpis.data === null && !kpis.isLoading && !kpis.isError;
  if (notConfigured) {
    return (
      <EmptyState
        icon={<Globe01 className="size-5" />}
        title={t("mainPanelTabs.cdnTab.audienceUnconfiguredTitle")}
        description={t("mainPanelTabs.cdnTab.audienceUnconfiguredBody")}
      />
    );
  }
  if (kpis.isError) {
    return (
      <EmptyState
        icon={<Globe01 className="size-5" />}
        title={t("mainPanelTabs.cdnTab.errorTitle")}
        description={(kpis.error as Error)?.message ?? ""}
      />
    );
  }

  const k = kpis.data?.results?.[0]?.metrics ?? null;
  const kPrev = kpis.data?.previous?.[0]?.metrics ?? null;
  const totalVisitors = k ? Number(k[0]) : null;
  const plottedDef = KPI_DEFS.find((d) => d.key === plotted) ?? KPI_DEFS[0];
  // When Compare is on, align the previous period by index so it overlays as a
  // muted line against the current one.
  const prevRows = timeseries.data?.previous ?? [];
  const chartData = (timeseries.data?.results ?? []).map((r, i) => ({
    bucket: r.dimensions[0] ?? "",
    value: Number(r.metrics[plottedDef.tsIdx] ?? 0),
    prev:
      compare && prevRows[i]
        ? Number(prevRows[i]!.metrics[plottedDef.tsIdx] ?? 0)
        : null,
  }));

  const hosts = hostsQuery.data ?? [];

  const toggle = <T extends string>(
    dims: readonly T[],
    active: T,
    set: (d: T) => void,
    label: (d: T) => string,
  ) => (
    <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
      {dims.map((d) => (
        <button
          key={d}
          type="button"
          onClick={() => set(d)}
          className={cn(
            "rounded-md px-2 py-0.5 text-xs font-medium transition-colors",
            active === d
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {label(d)}
        </button>
      ))}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterBar
          fields={OD_FILTER_FIELDS}
          filters={filters}
          onChange={setFilters}
        />
        {hosts.length > 1 && (
          <select
            value={host}
            onChange={(e) => setSelectedHost(e.target.value)}
            className="max-w-full truncate rounded-lg border border-border bg-card px-2 py-1 text-xs text-foreground"
          >
            {hosts.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* KPI cards — clickable to choose which metric the chart plots, each with
          a trend delta vs the previous window. */}
      {kpis.isLoading || !k ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {KPI_DEFS.map((d) => {
            const cur = Number(k[d.kpiIdx] ?? 0);
            const prev = kPrev ? Number(kPrev[d.kpiIdx] ?? 0) : null;
            const delta = prev && prev > 0 ? ((cur - prev) / prev) * 100 : null;
            const good = delta === null ? null : d.up ? delta >= 0 : delta <= 0;
            return (
              <button
                key={d.key}
                type="button"
                onClick={() => setPlotted(d.key)}
                className={cn(
                  "rounded-xl border bg-card px-4 py-3 text-left transition-colors",
                  plotted === d.key
                    ? "border-foreground/40"
                    : "border-border hover:border-border/70",
                )}
              >
                <div className="text-xs text-muted-foreground">
                  {t(`mainPanelTabs.cdnTab.${d.label}` as never)}
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-2xl font-semibold tabular-nums text-foreground">
                    {fmtKpi(d.fmt, cur)}
                  </span>
                  {delta !== null && (
                    <span
                      className={cn(
                        "text-xs font-medium tabular-nums",
                        good ? "text-emerald-600" : "text-rose-600",
                      )}
                    >
                      {delta >= 0 ? "↑" : "↓"}
                      {Math.abs(Math.round(delta))}%
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      <Card
        title={t(`mainPanelTabs.cdnTab.${plottedDef.label}` as never)}
        action={
          <span className="text-xs text-muted-foreground">{gmtLabel()}</span>
        }
      >
        {timeseries.isLoading ? (
          <Skeleton className="h-72 w-full" />
        ) : chartData.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("mainPanelTabs.cdnTab.emptyRange")}
          </p>
        ) : (
          <ChartContainer
            config={{
              value: {
                label: t(`mainPanelTabs.cdnTab.${plottedDef.label}` as never),
                color: COLOR_PAGEVIEWS,
              },
            }}
            className="h-72 w-full"
          >
            <AreaChart
              data={chartData}
              margin={{ top: 8, right: 8, bottom: 8, left: 0 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="bucket"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={32}
                tickFormatter={(v: string) => String(v).slice(5, 16)}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={48}
                tickFormatter={(v: number) =>
                  plottedDef.fmt === "dur"
                    ? formatDuration(v)
                    : plottedDef.fmt === "pct"
                      ? `${Math.round(v)}%`
                      : formatCompact(v)
                }
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Area
                dataKey="value"
                type="monotone"
                fill={COLOR_PAGEVIEWS}
                fillOpacity={0.15}
                stroke={COLOR_PAGEVIEWS}
                strokeWidth={2}
              />
              {compare && (
                <Line
                  dataKey="prev"
                  type="monotone"
                  dot={false}
                  strokeDasharray="4 4"
                  stroke="hsl(var(--muted-foreground))"
                  strokeWidth={1.5}
                />
              )}
            </AreaChart>
          </ChartContainer>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title={t("mainPanelTabs.cdnTab.mostViewedPages")}>
          {pages.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <RankedList
              items={odRankItems(pages.data?.results, 0)}
              emptyLabel={t("mainPanelTabs.cdnTab.emptyRange")}
            />
          )}
        </Card>
        <Card title={t("mainPanelTabs.cdnTab.referrers")}>
          {sources.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <RankedList
              items={odRankItems(sources.data?.results, 0, (raw) =>
                raw ? raw : t("mainPanelTabs.cdnTab.directUnknown"),
              )}
              emptyLabel={t("mainPanelTabs.cdnTab.emptyRange")}
            />
          )}
        </Card>
        <Card
          title={t("mainPanelTabs.cdnTab.topCountries")}
          action={toggle(
            ["map", "list"] as const,
            countryView,
            setCountryView,
            (v) =>
              t(
                v === "map"
                  ? "mainPanelTabs.cdnTab.mapView"
                  : "mainPanelTabs.cdnTab.listView",
              ),
          )}
        >
          {countries.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : countryView === "map" ? (
            <CountryMap
              rows={(countries.data?.results ?? []).map((r) => ({
                key: r.dimensions[0] ?? "",
                value: Number(r.metrics[0] ?? 0),
              }))}
            />
          ) : (
            <RankedList
              items={odRankItems(countries.data?.results, 0, formatCountry)}
              emptyLabel={t("mainPanelTabs.cdnTab.emptyRange")}
            />
          )}
        </Card>
        <Card
          title={t("mainPanelTabs.cdnTab.devices")}
          action={toggle(DEVICE_DIMS, deviceDim, setDeviceDim, (d) =>
            t(
              d === "browsers"
                ? "mainPanelTabs.cdnTab.browser"
                : d === "os"
                  ? "mainPanelTabs.cdnTab.os"
                  : "mainPanelTabs.cdnTab.device",
            ),
          )}
        >
          {deviceRows.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <RankedList
              items={odRankItems(deviceRows.data?.results, 0)}
              emptyLabel={t("mainPanelTabs.cdnTab.emptyRange")}
            />
          )}
        </Card>
        <Card title={t("mainPanelTabs.cdnTab.events")}>
          {events.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <OdMetricTable
              rows={events.data?.results}
              keyHeader={t("mainPanelTabs.cdnTab.event")}
              totalVisitors={totalVisitors}
              emptyLabel={t("mainPanelTabs.cdnTab.emptyRange")}
            />
          )}
        </Card>
        <Card
          title={t("mainPanelTabs.cdnTab.utm")}
          action={toggle(UTM_DIMS, utmDim, setUtmDim, (d) =>
            t(`mainPanelTabs.cdnTab.${d}` as never),
          )}
        >
          {utm.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <OdMetricTable
              rows={utm.data?.results}
              keyHeader={t("mainPanelTabs.cdnTab.value")}
              totalVisitors={totalVisitors}
              emptyLabel={t("mainPanelTabs.cdnTab.emptyRange")}
            />
          )}
        </Card>
      </div>
    </div>
  );
}

export function CdnTab({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const { org } = useProjectContext();
  const entity = useVirtualMCP(virtualMcpId);
  const siteSlug = resolveAgentSiteSlug(entity);
  const enabled = Boolean(siteSlug);
  const base = siteSlug
    ? `/api/${org.slug}/monitor/${encodeURIComponent(siteSlug)}`
    : "";
  const [sel, setSel] = useState<RangeSel>({
    range: "7d",
    since: "",
    until: "",
    compare: false,
  });
  const rangeExtra =
    sel.range === "custom" ? `&since=${sel.since}&until=${sel.until}` : "";
  const [section, setSection] = useState<"performance" | "audience">(
    "performance",
  );
  const hostsQuery = useOdHosts(base, Boolean(siteSlug));
  const hosts = hostsQuery.data ?? [];

  if (!siteSlug) {
    return (
      <EmptyState
        icon={<Globe01 className="size-5" />}
        title={t("mainPanelTabs.cdnTab.noSiteTitle")}
        description={t("mainPanelTabs.cdnTab.noSiteBody")}
      />
    );
  }

  const sections = [
    {
      id: "performance" as const,
      label: t("mainPanelTabs.cdnTab.performance"),
    },
    { id: "audience" as const, label: t("mainPanelTabs.cdnTab.audience") },
  ];

  return (
    <>
      <Main.Toolbar.Portal>
        <div className="flex w-full min-w-0 items-center justify-between gap-3 overflow-x-auto">
          <div
            role="group"
            aria-label={t("mainPanelTabs.cdnTab.title")}
            className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border p-0.5"
          >
            {sections.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={section === item.id}
                onClick={() => setSection(item.id)}
                className={cn(
                  "rounded-md px-3 py-1 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  section === item.id
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="shrink-0">
            <RangePicker value={sel} onChange={setSel} />
          </div>
        </div>
      </Main.Toolbar.Portal>

      <div className="h-full overflow-auto">
        <Main.Container
          width="wide"
          padding="compact"
          className="flex flex-col gap-4"
        >
          {hosts.length > 0 && (
            <p className="font-mono text-xs text-muted-foreground">
              {hosts[0]}
              {hosts.length > 1 &&
                ` ${t("mainPanelTabs.cdnTab.moreHostnames").replace(
                  "{count}",
                  String(hosts.length - 1),
                )}`}
            </p>
          )}

          {section === "performance" ? (
            <PerformanceSection
              base={base}
              range={sel.range}
              rangeExtra={rangeExtra}
              enabled={enabled}
            />
          ) : (
            <AudienceSection
              base={base}
              range={sel.range}
              rangeExtra={rangeExtra}
              compare={sel.compare}
              enabled={enabled}
            />
          )}
        </Main.Container>
      </div>
    </>
  );
}
