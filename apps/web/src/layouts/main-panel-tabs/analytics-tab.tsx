/**
 * AnalyticsTab — per-site Deco Analytics lifecycle (control-plane BFF proxy).
 *
 * Mirrors the control-plane `site-analytics.tsx` lifecycle with native Studio
 * components. Fetches `GET /analytics/status` first and branches:
 *   - `configured === false` → the collector isn't wired to this environment.
 *   - `configured && !registered` → a Register card (pick modules + optional
 *     host) that registers the site with the Deco Analytics collector.
 *   - `registered` → a registered view: Active/Paused badge, host + id + modules
 *     + sampling, Pause/Resume + Edit + Unregister actions, and a usage summary.
 *
 * All traffic flows through the same server-side proxy that powers Hosting — at
 * `/api/:org/hosting/:site/analytics/*` — so the control-plane service token
 * never reaches the browser. A 401 anywhere shows the calm "not connected"
 * state; loading shows a Skeleton.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BarChartSquare02,
  Pencil01,
  Power03,
  Trash01,
} from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Checkbox } from "@decocms/ui/components/checkbox.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
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
import { toast } from "sonner";
import { useProjectContext, useVirtualMCP } from "@/sdk";
import { resolveAgentSiteSlug } from "@decocms/shared/site-slug";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";

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
interface Usage {
  series?: unknown[];
  totals?: Record<string, unknown>;
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

// --- helpers ----------------------------------------------------------------

/** The pre-token condition: the upstream (or its proxy) answers 401. Rendered as
 *  a calm "not connected" state, not a red error. */
function isUnauthorized(error: unknown): boolean {
  const m = error instanceof Error ? error.message.toLowerCase() : "";
  return m.includes("unauthorized") || m.includes("401");
}

/** The control-plane returns 503 `not_configured` when analytics isn't set up
 *  for the site — rendered as a friendly "no data" state, not an error. */
function isNotConfigured(error: unknown): boolean {
  const m = error instanceof Error ? error.message.toLowerCase() : "";
  return m.includes("not_configured") || m.includes("not configured");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Turn a totals key (`events_accepted`, `bytes_in`) into a readable label. */
function metricLabel(key: string): string {
  const spaced = key.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatNumber(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat().format(n);
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

// --- usage summary ----------------------------------------------------------

/** Usage totals for the registered site — tiles keyed off the `totals` map. */
function UsageSummary({
  base,
  orgSlug,
  site,
}: {
  base: string;
  orgSlug: string;
  site: string;
}) {
  const t = useT();
  const usageQuery = useQuery({
    queryKey: KEYS.analyticsUsage(orgSlug, site),
    queryFn: () => fetchJson(`${base}/analytics/usage`),
    retry: false,
    staleTime: 30_000,
  });

  // 401 / not_configured / errors: the registered view still stands on its own,
  // so a usage miss is silent rather than a red error.
  if (usageQuery.error) {
    if (isNotConfigured(usageQuery.error) || isUnauthorized(usageQuery.error)) {
      return null;
    }
  }

  const usage = (usageQuery.data ?? {}) as Usage;
  const totalEntries = Object.entries(usage.totals ?? {});

  return (
    <Card title={t("mainPanelTabs.analyticsTab.usageTitle")}>
      {usageQuery.isLoading ? (
        <div className="flex flex-wrap gap-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="flex flex-1 min-w-[140px] flex-col gap-2 rounded-xl border border-border bg-card p-4"
            >
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-7 w-20" />
            </div>
          ))}
        </div>
      ) : totalEntries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("mainPanelTabs.analyticsTab.usageEmpty")}
        </p>
      ) : (
        <div className="flex flex-wrap gap-3">
          {totalEntries.map(([key, value]) => (
            <StatCard
              key={key}
              label={metricLabel(key)}
              value={formatNumber(value)}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

// --- install panel ----------------------------------------------------------

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

// --- registered view --------------------------------------------------------

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

      <UsageSummary base={base} orgSlug={orgSlug} site={site} />

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
