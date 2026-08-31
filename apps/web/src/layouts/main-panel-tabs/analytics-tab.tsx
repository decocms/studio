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
  ChevronDown,
  Pencil01,
  Power03,
  Trash01,
} from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Checkbox } from "@decocms/ui/components/checkbox.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@decocms/ui/components/collapsible.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@decocms/ui/components/table.tsx";
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
import type { TranslationKey } from "@/i18n/en/index.ts";

// --- control-plane REST DTOs (client-safe fields only) ---------------------

interface SiteConfig {
  id?: string;
  enabled?: boolean;
  sampling?: number;
  tier?: string;
  modules?: string[];
  domains?: string[];
}
interface AnalyticsStatus {
  configured?: boolean;
  registered?: boolean;
  host?: string | null;
  config?: SiteConfig | null;
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

// The dashboard views, in the order the internal admin UI shows them. `pipeline`
// and `install` are omitted on purpose: `pipeline` is operator-only (no tenant
// policy) and `install` carries only the internals the BFF strips, so it would
// render empty here. Labels come from i18n.
const DATA_VIEWS: ReadonlyArray<{ view: string; labelKey: TranslationKey }> = [
  { view: "overview", labelKey: "mainPanelTabs.analyticsTab.viewOverview" },
  { view: "live", labelKey: "mainPanelTabs.analyticsTab.viewLive" },
  { view: "behaviour", labelKey: "mainPanelTabs.analyticsTab.viewBehaviour" },
  { view: "events", labelKey: "mainPanelTabs.analyticsTab.viewEvents" },
  { view: "errors", labelKey: "mainPanelTabs.analyticsTab.viewErrors" },
  {
    view: "experiments",
    labelKey: "mainPanelTabs.analyticsTab.viewExperiments",
  },
  { view: "vitals", labelKey: "mainPanelTabs.analyticsTab.viewVitals" },
  { view: "quality", labelKey: "mainPanelTabs.analyticsTab.viewQuality" },
  { view: "usage", labelKey: "mainPanelTabs.analyticsTab.viewUsage" },
];

const RANGES: ReadonlyArray<{ value: string; labelKey: TranslationKey }> = [
  { value: "24h", labelKey: "mainPanelTabs.analyticsTab.range24h" },
  { value: "7d", labelKey: "mainPanelTabs.analyticsTab.range7d" },
  { value: "30d", labelKey: "mainPanelTabs.analyticsTab.range30d" },
  { value: "1h", labelKey: "mainPanelTabs.analyticsTab.range1h" },
  { value: "30m", labelKey: "mainPanelTabs.analyticsTab.range30m" },
  { value: "15m", labelKey: "mainPanelTabs.analyticsTab.range15m" },
  { value: "5m", labelKey: "mainPanelTabs.analyticsTab.range5m" },
];

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
    value === null ||
    ["string", "number", "boolean"].includes(typeof value)
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

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-1 min-w-[140px] flex-col gap-1 rounded-xl border border-border bg-card p-4">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold text-foreground tabular-nums">
        {value}
      </span>
    </div>
  );
}

/** A collapsible section with a chevron trigger. Children render only while open
 *  (the caller gates its data fetch on `open`), so a screenful of sections
 *  doesn't fan out queries until each is expanded. */
function Section({
  title,
  defaultOpen,
  onOpenChange,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange?.(next);
      }}
      className="rounded-xl border border-border bg-card overflow-hidden"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-muted/40">
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
        <span className="text-sm font-medium text-foreground">{title}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-border p-4">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

// --- generic panel rendering ------------------------------------------------

/** A tiny dependency-free bar strip for a time series — enough visual signal for
 *  a design pass without pulling a chart lib. The full table sits below it. */
function SparkBars({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  return (
    <div className="flex h-16 items-end gap-0.5">
      {values.map((v, i) => (
        <div
          key={i}
          className="flex-1 rounded-sm bg-primary/60"
          style={{ height: `${Math.max(2, (v / max) * 100)}%` }}
          title={formatNumber(v)}
        />
      ))}
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
  const shown = rows.slice(0, 100);
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((c) => (
              <TableHead key={c} className="whitespace-nowrap">
                {humanize(c)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((row, i) => (
            <TableRow key={i}>
              {columns.map((c) => (
                <TableCell key={c} className="whitespace-nowrap tabular-nums">
                  {formatCell(row[c])}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** One panel from a view payload, shape-detected: a single scalar row → stat
 *  tiles; a time series → sparkline + table; anything else → a table. */
function PanelBlock({
  name,
  rows,
  t,
}: {
  name: string;
  rows: Array<Record<string, unknown>>;
  t: TFunction;
}) {
  const title = humanize(name);

  if (rows.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
        <p className="text-sm text-muted-foreground">
          {t("mainPanelTabs.analyticsTab.panelEmpty")}
        </p>
      </div>
    );
  }

  // rows is non-empty here (the length-0 case returned above); `first` is the
  // shape probe for the whole panel.
  const first = rows[0] ?? {};

  // Single row of scalars → KPI tiles.
  if (rows.length === 1 && Object.values(first).every(isScalar)) {
    const entries = Object.entries(first);
    return (
      <div className="flex flex-col gap-2">
        <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
        <div className="flex flex-wrap gap-3">
          {entries.map(([k, v]) => (
            <StatCard key={k} label={humanize(k)} value={formatCell(v)} />
          ))}
        </div>
      </div>
    );
  }

  const columns = Object.keys(first);
  const timeKey = columns.find((c) => TIME_KEY.test(c));
  const metricKey =
    timeKey &&
    columns.find((c) => c !== timeKey && typeof first[c] === "number");
  const series =
    timeKey && metricKey ? rows.map((r) => Number(r[metricKey]) || 0) : null;

  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
      {series && series.length > 1 && <SparkBars values={series} />}
      <DataTable rows={rows} />
    </div>
  );
}

/** Render every panel in a view payload. Meta keys and non-array values are
 *  skipped; the rest become PanelBlocks in payload order. */
function ViewPanels({
  payload,
  t,
}: {
  payload: Record<string, unknown>;
  t: TFunction;
}) {
  const panels = Object.entries(payload).filter(
    ([key, value]) => !META_KEYS.has(key) && Array.isArray(value),
  ) as Array<[string, Array<Record<string, unknown>>]>;

  const hasAny = panels.some(([, rows]) => rows.length > 0);
  if (!hasAny) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("mainPanelTabs.analyticsTab.dataEmpty")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {panels.map(([name, rows]) => (
        <PanelBlock key={name} name={name} rows={rows} t={t} />
      ))}
    </div>
  );
}

// --- one dashboard view section ---------------------------------------------

function ViewSection({
  base,
  orgSlug,
  site,
  view,
  title,
  range,
  defaultOpen,
}: {
  base: string;
  orgSlug: string;
  site: string;
  view: string;
  title: string;
  range: string;
  defaultOpen?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(Boolean(defaultOpen));

  const query = useQuery({
    queryKey: KEYS.analyticsData(orgSlug, site, view, range),
    queryFn: () =>
      fetchJson(
        `${base}/analytics/data?view=${encodeURIComponent(
          view,
        )}&range=${encodeURIComponent(range)}`,
      ),
    enabled: open,
    retry: false,
    staleTime: 30_000,
  });

  const response = (query.data ?? {}) as AnalyticsDataResponse;

  return (
    <Section title={title} defaultOpen={defaultOpen} onOpenChange={setOpen}>
      {query.isLoading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : query.error ? (
        <p className="text-sm text-muted-foreground">
          {isNotConfigured(query.error)
            ? t("mainPanelTabs.analyticsTab.dataNotConfiguredDescription")
            : t("mainPanelTabs.analyticsTab.dataLoadError")}
        </p>
      ) : response.data ? (
        <ViewPanels payload={response.data} t={t} />
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("mainPanelTabs.analyticsTab.dataEmpty")}
        </p>
      )}
    </Section>
  );
}

// --- install / tracking (use-only) ------------------------------------------

/** How to USE analytics for this site — a minimal, use-only summary.
 *  IMPORTANT: this is an internal module surfaced in the (open-source) Studio.
 *  It must NOT demonstrate our delivery / caching / billing internals — only
 *  what the site owner needs: it's active automatically, and custom events are
 *  sent through the public `window.__dq` client API. */
function InstallPanel() {
  const t = useT();
  return (
    <Card title={t("mainPanelTabs.analyticsTab.installTitle")}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          {t("mainPanelTabs.analyticsTab.installAuto")}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("mainPanelTabs.analyticsTab.installTrackPrefix")}
          <span className="font-mono">window.__dq</span> —{" "}
          <span className="font-mono">pageview()</span>,{" "}
          <span className="font-mono">track(name, props)</span>,{" "}
          <span className="font-mono">purchase(&#123;…&#125;)</span>.
        </p>
      </div>
    </Card>
  );
}

// --- register (not yet registered) ------------------------------------------

function RegisterCard({
  base,
  orgSlug,
  site,
  host,
}: {
  base: string;
  orgSlug: string;
  site: string;
  host: string | null;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(
    new Set(["core", "commerce", "vitals"]),
  );
  const [hostOverride, setHostOverride] = useState("");

  const registerMutation = useMutation({
    mutationFn: (input: { modules: string[]; host?: string }) =>
      mutateJson(`${base}/analytics/register`, "POST", input),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: KEYS.analyticsStatus(orgSlug, site),
      });
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

  const handleRegister = () => {
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
            host: effectiveHost,
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

        {!host && (
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
        )}

        <p className="text-xs text-muted-foreground">
          {t("mainPanelTabs.analyticsTab.registerInstallHint")}
        </p>

        <div className="flex justify-end">
          <Button
            onClick={handleRegister}
            disabled={
              registerMutation.isPending || (!host && !hostOverride.trim())
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

  const saveMutation = useMutation({
    mutationFn: (input: { modules: string[]; sampling: number }) =>
      mutateJson(`${base}/analytics/config`, "PUT", input),
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

  const handleSave = () => {
    const pct = Number(samplingPct);
    const sampling =
      Number.isFinite(pct) && pct > 0 ? Math.min(pct, 100) / 100 : 1;
    saveMutation.mutate({ modules: [...selected], sampling });
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
            disabled={saveMutation.isPending}
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

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: KEYS.analyticsStatus(orgSlug, site),
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

      <InstallPanel />

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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">
          {t("mainPanelTabs.analyticsTab.dashboardTitle")}
        </h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {t("mainPanelTabs.analyticsTab.rangeLabel")}
          </span>
          <Select value={range} onValueChange={setRange}>
            <SelectTrigger className="h-8 w-[160px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RANGES.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {t(r.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {DATA_VIEWS.map((v, i) => (
          <ViewSection
            key={v.view}
            base={base}
            orgSlug={orgSlug}
            site={site}
            view={v.view}
            title={t(v.labelKey)}
            range={range}
            defaultOpen={i === 0}
          />
        ))}
      </div>

      <Section title={t("mainPanelTabs.analyticsTab.configSectionTitle")}>
        <ConfigurationPanel
          base={base}
          orgSlug={orgSlug}
          site={site}
          status={status}
        />
      </Section>
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
      <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
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

        {statusQuery.isLoading ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : statusQuery.error ? (
          <EmptyState
            icon={<BarChartSquare02 className="size-5" />}
            title={t("mainPanelTabs.analyticsTab.statusError")}
          />
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
          />
        )}
      </div>
    </div>
  );
}
