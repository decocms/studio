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
 *      Overview is the home: it polls `live` itself, so "now" is not a tab.
 *
 *   2. Configuration — configure, pause-resume or unregister a registered site.
 *
 * Status drives the shell: `configured === false` → collector not wired;
 * `!registered` → a notice to ask the deco team to activate it;
 * `registered` → dashboard sections + a Configuration section. A 401 anywhere
 * shows the calm "not connected" state; the data surface being unset degrades to
 * "dashboard unavailable" while configuration still works.
 *
 * IMPORTANT: this tab ships in the open-source Studio. It shows only what a site
 * owner needs — never delivery/caching/billing internals (the BFF forwards
 * only the payload keys this tab and the heatmap read; see
 * `ANALYTICS_PAYLOAD_KEYS` in apps/api hosting.ts).
 */

import { type ReactNode, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronRight,
  Copy01,
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
import { toast } from "sonner";
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
  /** Accepted events per calendar month (uncapped when absent). */
  quota?: number;
}
export interface AnalyticsStatus {
  configured?: boolean;
  registered?: boolean;
  host?: string | null;
  config?: SiteConfig | null;
  /** The public declared key (`dq_…`) for a keyed site — it ships in the page,
   *  so it is shown, not hidden. */
  key?: string | null;
  /** A site deco doesn't host, registered from its project: the control-plane
   *  has no record of it, so nothing here can configure it. */
  external?: boolean;
}

/** The one-time result of a registration. `key`/`snippet` come back once, at
 *  creation, and only for a token (key) registration; `notes` carries the
 *  collector's warnings (e.g. `deco` auto-added, or the `_dq` route not yet
 *  reachable). */
export interface AnalyticsRegisterResult {
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
  {
    key: "heatmap",
    labelKey: "mainPanelTabs.analyticsTab.moduleHeatmap",
    hintKey: "mainPanelTabs.analyticsTab.moduleHeatmapHint",
  },
] as const;

// Range pills, shortest first — the admin's 5m…30d selector.
export const RANGE_PILLS = [
  "5m",
  "15m",
  "30m",
  "1h",
  "24h",
  "7d",
  "30d",
] as const;

// --- helpers ----------------------------------------------------------------

/** Thrown by {@link fetchJson}/{@link mutateJson}; carries the real HTTP status
 *  so callers don't have to guess it back out of the error message. */
class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The upstream/proxy answers "not configured" (503) — a friendly "no data"
 *  state, not an error. Matches both the control-plane's `not_configured` and
 *  the BFF's "…is not configured" for the data surface. */
export function isNotConfigured(error: unknown): boolean {
  const m = error instanceof Error ? error.message.toLowerCase() : "";
  return m.includes("not_configured") || m.includes("not configured");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `request failed (${res.status})`;
    throw new ApiError(err, res.status);
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
    throw new ApiError(err, res.status);
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
    <section className="surface overflow-hidden">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {action && <div className="ml-auto">{action}</div>}
      </header>
      <div className="p-4">{children}</div>
    </section>
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
          <span className="text-2xs font-medium text-muted-foreground">
            {t("mainPanelTabs.analyticsTab.installHostTitle")}
          </span>
          <p className="text-xs text-muted-foreground">
            {t("mainPanelTabs.analyticsTab.installAuto")}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-2xs font-medium text-muted-foreground">
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

// --- one-time registration result (key rotation) ----------------------------

/** Copy-to-clipboard button for the one-time snippet/token. */
export function CopyButton({ text }: { text: string }) {
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
              className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning"
            >
              {n}
            </li>
          ))}
        </ul>
      )}
    </section>
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
            <Label htmlFor="analytics-quota">
              {t("mainPanelTabs.analyticsTab.monthlyQuota")}
            </Label>
            <Input
              id="analytics-quota"
              type="number"
              min={1}
              value={quota}
              placeholder={t("mainPanelTabs.analyticsTab.uncapped")}
              onChange={(e) => setQuota(e.target.value)}
              aria-invalid={quotaError != null}
              className="font-mono text-xs"
            />
            {quotaError ? (
              <span className="text-xs text-destructive">{quotaError}</span>
            ) : quotaCleared ? (
              <span className="text-xs text-warning">
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
export function ConfigurationPanel({
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
              variant="ghost-destructive"
              aria-label={t("mainPanelTabs.analyticsTab.unregister")}
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

      {/* Mounted only while open, so a cancelled draft doesn't come back. */}
      {editOpen && (
        <EditAnalyticsDialog
          base={base}
          orgSlug={orgSlug}
          site={site}
          config={cfg}
          open
          onOpenChange={setEditOpen}
        />
      )}

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
              variant="destructive"
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

/** A naturally-closed row documenting the client API, mirroring the admin
 *  UI's install text — collapsed by default so it doesn't crowd the data. */
export function CustomEventsHelp() {
  const t = useT();
  const H = "mainPanelTabs.analyticsTab.eventsHelp";
  const mono = (chunk: ReactNode) => (
    <span className="font-mono text-foreground">{chunk}</span>
  );
  return (
    <details className="group surface">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-foreground hover:bg-accent">
        <ChevronRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
        {t(`${H}.title`)}
      </summary>
      <div className="flex flex-col gap-3 border-t border-border px-4 py-4 text-sm text-muted-foreground">
        <p>
          {t(`${H}.intro`)} {mono("window.__dq")}:
        </p>
        <dl className="flex flex-col gap-2">
          <div className="flex flex-col gap-0.5">
            <dt className="font-mono text-xs text-foreground">pageview()</dt>
            <dd className="text-xs">{t(`${H}.pageview`)}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="font-mono text-xs text-foreground">
              track(name, props?)
            </dt>
            <dd className="text-xs">{t(`${H}.track`)}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="font-mono text-xs text-foreground">
              purchase(&#123; transactionId, value, currency, items, itemIds
              &#125;)
            </dt>
            <dd className="text-xs">{t(`${H}.purchase`)}</dd>
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
  );
}
