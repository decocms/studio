/**
 * The pieces every Deco Analytics section is drawn with: reading a view's
 * payload, number formats, a ranked list whose rows filter the segment, a
 * plain table, and the states a panel can be in. Shaped after the Monitor's
 * Audience cards so the sections read as one screen with the rest.
 */

import { type ReactNode, useState } from "react";
import { BarChart10, Check } from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@decocms/ui/components/toggle-group.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@decocms/ui/components/table.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { formatCountry } from "@/layouts/main-panel-tabs/cdn-tab";
import { changeTone } from "@/layouts/main-panel-tabs/monitor-v8";
import { MetricCard } from "@/layouts/task-board/analytics-sections";
import { useDecoView, type FilterDim } from "./segment";
import { useRowFilter } from "./segment-bar";
import type { SectionProps } from "./types";

// --- reading a payload ------------------------------------------------------

export type Row = Record<string, unknown>;
export type Payload = Record<string, unknown>;

export function rowsOf(data: Payload | undefined, key: string): Row[] {
  const v = data?.[key];
  return Array.isArray(v)
    ? v.filter((r): r is Row => typeof r === "object" && r !== null)
    : [];
}

export function firstRow(data: Payload | undefined, key: string): Row | null {
  return rowsOf(data, key)[0] ?? null;
}

/** A number, or null when absent or not numeric (ClickHouse sends UInt64 as strings). */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export const n0 = (v: unknown): number => num(v) ?? 0;
export const str = (v: unknown): string =>
  v === null || v === undefined ? "" : String(v);

/** `{ k, n }` rows, the shape of every ranked panel. */
export function kn(rows: Row[]): { k: string; n: number }[] {
  return rows.map((r) => ({ k: str(r.k), n: n0(r.n) }));
}

/** One view of the read surface for the section's range and segment. */
export function useSectionView(props: SectionProps, view: string) {
  const query = useDecoView({
    orgSlug: props.orgSlug,
    site: props.site,
    view,
    range: props.range,
    segment: props.segment,
  });
  return {
    data: query.data?.data,
    isLoading: query.isLoading,
    error: query.error,
  };
}

/** The money every revenue figure is for, and whether the goal carries any. */
export function moneyOf(data: Payload | undefined): {
  currency: string | null;
  hasRevenue: boolean;
} {
  const currency = typeof data?.currency === "string" ? data.currency : null;
  const goals = Array.isArray(data?.goals) ? data.goals : [];
  const goalId = typeof data?.goal === "string" ? data.goal : "purchase";
  const goal = goals.find(
    (g): g is { id: string; revenue?: unknown } =>
      typeof g === "object" && g !== null && "id" in g && g.id === goalId,
  );
  return { currency, hasRevenue: goal ? Boolean(goal.revenue) : true };
}

// --- formats ----------------------------------------------------------------

export function fmtInt(v: unknown): string {
  const n = num(v);
  return n === null ? "—" : new Intl.NumberFormat().format(Math.round(n));
}

export function fmtPct(v: number | null, digits = 1): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return `${new Intl.NumberFormat(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(v)}%`;
}

export function ratioPct(part: number, whole: number): number | null {
  return whole > 0 ? (100 * part) / whole : null;
}

export function fmtMoney(
  v: unknown,
  currency: string | null,
  digits = 0,
): string {
  const n = num(v);
  if (n === null) return "—";
  if (!currency) {
    return new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 2,
    }).format(n);
  }
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: digits,
    }).format(n);
  } catch {
    return `${new Intl.NumberFormat().format(Math.round(n))} ${currency}`;
  }
}

export function fmtDuration(v: unknown): string {
  const n = num(v);
  if (n === null) return "—";
  const m = Math.floor(n / 60);
  const s = Math.round(n % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function fmtMs(v: unknown): string {
  const n = num(v);
  if (n === null) return "—";
  return n >= 1000
    ? `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n / 1000)} s`
    : `${Math.round(n)} ms`;
}

export function fmtBytes(v: unknown): string {
  const n = num(v);
  if (n === null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let x = n;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(x)} ${units[i]}`;
}

/** Warehouse timestamps are UTC `YYYY-MM-DD hh:mm:ss`. */
function utcDate(v: unknown): Date | null {
  const s = str(v);
  if (!s) return null;
  const iso = s.length === 10 ? `${s}T00:00:00Z` : `${s.replace(" ", "T")}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtWhen(v: unknown): string {
  const d = utcDate(v);
  return d
    ? d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
}

/** A series bucket as an axis tick: a time within a day, else the date. */
export function bucketTick(v: string): string {
  const d = utcDate(v);
  if (!d) return v;
  return v.length > 10
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The flag of a two-letter country code, from its regional indicators. */
function countryFlag(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return "";
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)),
  );
}

export function countryLabel(code: string): ReactNode {
  const flag = countryFlag(code);
  return (
    <>
      {flag && <span aria-hidden>{flag} </span>}
      {formatCountry(code)}
    </>
  );
}

export const capitalize = (s: string) =>
  s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

// --- states -----------------------------------------------------------------

export function SectionSkeleton({ tiles = 0 }: { tiles?: number }) {
  return (
    <>
      {tiles > 0 && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          {Array.from({ length: tiles }, (_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      )}
      <Skeleton className="h-64" />
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-56" />
        <Skeleton className="h-56" />
      </div>
    </>
  );
}

export function SectionError({ error }: { error: Error }) {
  const t = useT();
  return (
    <EmptyState
      icon={<BarChart10 size={20} />}
      title={t("monitor.analytics.panels.error")}
      description={error.message}
    />
  );
}

/** A whole section with nothing to show, and why. */
export function SectionEmpty({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
}) {
  return (
    <div className="surface">
      <EmptyState
        size="inline"
        icon={icon}
        title={title}
        description={description}
      />
    </div>
  );
}

function NoRows() {
  const t = useT();
  return <p className="text-meta">{t("monitor.analytics.panels.empty")}</p>;
}

/** A number the data cannot support, said in a badge rather than printed. */
export function WithheldBadge({ label, tip }: { label: string; tip: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="warning" className="cursor-default">
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{tip}</TooltipContent>
    </Tooltip>
  );
}

// --- layout -----------------------------------------------------------------

/** A titled card: the Monitor's MetricCard. */
export const Panel = MetricCard;

/** A labelled block of panels on a long section. */
export function Group({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 pt-2">
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
      {children}
    </section>
  );
}

// --- change vs the prior window ---------------------------------------------

/**
 * Change against the window of the same length before this one. Rates move in
 * points; everything else in percent of itself. A prior window the site was
 * collecting less than 90% of is not a baseline, so the change is withheld.
 */
export function PrevChange({
  current,
  previous,
  covered,
  better,
  points = false,
}: {
  current: number | null;
  previous: number | null;
  covered: number | null;
  better: "up" | "down";
  points?: boolean;
}) {
  const t = useT();
  if (current === null || previous === null) return null;
  if (covered !== null && covered < 0.9) {
    return (
      <WithheldBadge
        label={t("monitor.analytics.panels.prev.partial", {
          pct: Math.round(100 * covered),
        })}
        tip={t("monitor.analytics.panels.prev.partialTip")}
      />
    );
  }
  if (!points && !previous) return null;
  const diff = points
    ? current - previous
    : (100 * (current - previous)) / previous;
  const rounded = Math.round(diff);
  if (rounded === 0) {
    return (
      <span className="text-meta">
        {t("monitor.analytics.panels.prev.flat")}
      </span>
    );
  }
  const tone = changeTone(diff / 100, better);
  const value = points
    ? t("monitor.analytics.panels.prev.points", {
        n: `${rounded > 0 ? "+" : "−"}${Math.abs(rounded)}`,
      })
    : `${rounded > 0 ? "+" : "−"}${Math.abs(rounded)}%`;
  return (
    <span className="text-meta tnum inline-flex items-center gap-1">
      <span
        className={cn(
          "font-medium",
          tone === "good" && "text-success",
          tone === "bad" && "text-destructive",
        )}
      >
        {value}
      </span>
      {t("monitor.analytics.panels.prev.vsPrior")}
    </span>
  );
}

// --- ranked list ------------------------------------------------------------

export interface RankedRow {
  k: string;
  n: number;
}

interface RankedRowsProps {
  rows: RankedRow[];
  dim?: FilterDim;
  /** The filter value of a row when it isn't the row's key. */
  filterValue?: (k: string) => string;
  label?: (k: string) => ReactNode;
  /** A second figure after the count, e.g. converters. */
  extra?: (row: RankedRow) => ReactNode;
  /** How a row's figure reads; a plain count by default. */
  format?: (n: number) => string;
  /** A dot's color class, for rows whose kind has a meaning (2xx, a cache hit). */
  dot?: (k: string) => string;
  limit?: number;
  /** Past the limit, a button that lists every row. */
  expandable?: boolean;
  share?: boolean;
}

/**
 * A ranked breakdown, busiest first, each row a bar to its share of the top.
 * With `dim`, a row is a filter toggle: clicking it segments every section to
 * the people who match it.
 */
export function RankedList({
  title,
  aside,
  ...rest
}: RankedRowsProps & { title: string; aside?: ReactNode }) {
  return (
    <Panel title={title} aside={aside}>
      <RankedRows {...rest} />
    </Panel>
  );
}

export interface RankedOption extends RankedRowsProps {
  id: string;
  /** The option's name in the card's corner. */
  name: string;
  /** Drawn instead of the rows, e.g. the countries on a map. */
  body?: ReactNode;
}

/**
 * One card for several cuts of the same people (device, browser, OS), picked
 * in its corner instead of a card each.
 */
export function RankedChoice({
  title,
  options,
}: {
  title: string;
  options: RankedOption[];
}) {
  const [picked, setPicked] = useState(options[0]?.id);
  const current = options.find((o) => o.id === picked) ?? options[0];
  if (!current) return null;
  const { id: _id, name: _name, body, ...rows } = current;
  return (
    <Panel
      title={title}
      aside={
        options.length > 1 && (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={current.id}
            onValueChange={(v) => v && setPicked(v)}
          >
            {options.map((o) => (
              <ToggleGroupItem
                key={o.id}
                value={o.id}
                className="flex-none px-2.5 text-xs font-normal"
              >
                {o.name}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )
      }
    >
      {body ?? <RankedRows {...rows} />}
    </Panel>
  );
}

/** The rows of a ranked list, for a card that holds more than the list. */
function RankedRows({
  rows,
  dim,
  filterValue,
  label,
  extra,
  format = fmtInt,
  dot,
  limit = 8,
  expandable = true,
  share = true,
}: RankedRowsProps) {
  const t = useT();
  const rowFilter = useRowFilter();
  const [all, setAll] = useState(false);
  const named = rows.filter((r) => r.k !== "");
  const top = all ? named : named.slice(0, limit);
  const max = Math.max(1, ...top.map((r) => r.n));
  const total = rows.reduce((a, r) => a + r.n, 0);
  if (top.length === 0) return <NoRows />;
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1">
        {top.map((row) => {
          const props = dim
            ? rowFilter(dim, filterValue ? filterValue(row.k) : row.k)
            : null;
          return (
            <li
              key={row.k}
              {...props}
              className={cn(
                "group relative flex items-center rounded-md",
                props &&
                  "focus-ring cursor-pointer hover:bg-accent/60 aria-pressed:bg-accent",
              )}
            >
              <span
                className="surface-inset absolute inset-y-0 left-0 group-aria-pressed:bg-foreground/10"
                style={{ width: `${(row.n / max) * 100}%` }}
              />
              <span className="relative flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-sm text-foreground">
                {dot && (
                  <span
                    className={cn("size-2 shrink-0 rounded-full", dot(row.k))}
                  />
                )}
                <span className="truncate">{label ? label(row.k) : row.k}</span>
                {props && (
                  <Check
                    size={14}
                    className="hidden shrink-0 text-foreground group-aria-pressed:block"
                  />
                )}
              </span>
              {extra && (
                <span className="tnum relative px-2 text-sm text-muted-foreground">
                  {extra(row)}
                </span>
              )}
              {share && (
                <span className="text-meta tnum relative w-12 shrink-0 text-right">
                  {total > 0 ? fmtPct((100 * row.n) / total, 0) : ""}
                </span>
              )}
              <span className="tnum relative min-w-20 shrink-0 px-2 text-right text-sm whitespace-nowrap text-foreground">
                {format(row.n)}
              </span>
            </li>
          );
        })}
      </ul>
      {expandable && named.length > limit && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="text-meta self-start px-2 hover:text-foreground"
        >
          {all
            ? t("mainPanelTabs.cdnTab.showLess")
            : t("mainPanelTabs.cdnTab.showAll")}
        </button>
      )}
    </div>
  );
}

/** `mobile · Chrome` rows summed by the part a filter can match. */
export function splitRows(
  rows: RankedRow[],
  part: "first" | "second",
): RankedRow[] {
  const sums = new Map<string, number>();
  for (const r of rows) {
    const [a, b = ""] = r.k.split(" · ");
    const k = part === "first" ? (a ?? "") : b;
    if (k) sums.set(k, (sums.get(k) ?? 0) + r.n);
  }
  return [...sums].map(([k, n]) => ({ k, n })).sort((x, y) => y.n - x.n);
}

// --- table ------------------------------------------------------------------

export interface Column<T> {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  numeric?: boolean;
  /** Applies to the body cells only. */
  className?: string;
}

/**
 * A designed table: translated headers, numbers right-aligned in tabular
 * figures. With `filter`, each row toggles a filter like a ranked row does.
 */
export function PanelTable<T>({
  columns,
  rows,
  rowKey,
  filter,
}: {
  columns: ReadonlyArray<Column<T>>;
  rows: ReadonlyArray<T>;
  rowKey: (row: T, i: number) => string;
  filter?: (row: T) => { d: FilterDim; v: string } | null;
}) {
  const rowFilter = useRowFilter();
  if (rows.length === 0) return <NoRows />;
  return (
    <div className="overflow-x-auto">
      <Table variant="flush">
        <TableHeader>
          <TableRow className="border-border hover:bg-transparent">
            {columns.map((c) => (
              <TableHead
                key={c.id}
                className={cn(
                  "h-8 whitespace-nowrap px-2 text-xs font-normal text-muted-foreground first:pl-0 last:pr-0",
                  c.numeric && "text-right",
                )}
              >
                {c.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => {
            const f = filter?.(row) ?? null;
            const props = f ? rowFilter(f.d, f.v) : null;
            return (
              <TableRow
                key={rowKey(row, i)}
                {...props}
                className={cn(
                  "group border-border/50",
                  props
                    ? "focus-ring cursor-pointer aria-pressed:bg-accent"
                    : "hover:bg-transparent",
                )}
              >
                {columns.map((c) => (
                  <TableCell
                    key={c.id}
                    className={cn(
                      "px-2 py-2 text-sm text-foreground first:pl-0 last:pr-0",
                      c.numeric && "tnum text-right",
                      c.className,
                    )}
                  >
                    {c.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/** The row's key, with a check when its filter is on (inside a filter row). */
export function FilterKey({ children }: { children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate">{children}</span>
      <Check size={14} className="hidden shrink-0 group-aria-pressed:block" />
    </span>
  );
}
