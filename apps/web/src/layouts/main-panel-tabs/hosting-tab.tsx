/**
 * HostingTab — per-site hosting view (control-plane BFF proxy).
 *
 * Surfaces deployments, environment variables, secrets, and redirects for the
 * site this agent resolves against. All traffic flows through the server-side
 * proxy at `/api/:org/hosting/:site/*`, so the control-plane service token never
 * reaches the browser — the client only ever sees the proxied JSON.
 *
 * Interactive: deploy from the header, and add/edit/delete env vars, secrets,
 * and redirects. Env is a REPLACE-SET on the control-plane, so every env
 * mutation computes the full desired list and PUTs it. Secret values are
 * write-only — the list returns names only, and a value is never rendered.
 */

import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy01,
  CornerUpRight,
  FileCode02,
  FlipBackward,
  GitCommit,
  Globe01,
  LinkExternal01,
  Pencil01,
  Plus,
  RefreshCw02,
  Rocket01,
  Server01,
  Trash01,
  Zap,
} from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@decocms/ui/components/table.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { toast } from "sonner";
import { useProjectContext, useVirtualMCP } from "@/sdk";
import { resolveAgentSiteSlug } from "@decocms/shared/site-slug";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";
import { Main } from "@/components/main";

// --- control-plane REST DTOs (client-safe fields only) ---------------------

interface Deployment {
  id: string;
  env?: string | null;
  framework?: string | null;
  commitSha?: string | null;
  shortCommit?: string | null;
  phase?: string | null;
  up?: boolean | null;
  production?: boolean | null;
  servingUrl?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  durationMs?: number | null;
  createdAt?: string | null;
  source?: "managed" | "observed" | string;
  buildMessage?: string | null;
}
/** One deploy-timeline event (deploy / redeploy / rollback). */
interface DeploymentHistoryEvent {
  id: string;
  env?: string | null;
  commitSha?: string | null;
  deploymentId?: string | null;
  framework?: string | null;
  action?: string | null;
  /** Event kind: `build` | `fast-deploy` | `deploy`. Absent on legacy rows. */
  type?: string | null;
  /** Event outcome: `pending` | `success` | `failure`. Absent on legacy rows. */
  outcome?: string | null;
  actor?: string | null;
  createdAt?: string | null;
}
/** Build-logs payload for one commit/env. `configured:false` means the platform
 *  has no build-log wiring; otherwise `text` is inline and `url` is a presigned
 *  link (expires ~5min — never cached). */
interface BuildLogs {
  configured?: boolean;
  available?: boolean;
  reason?: string | null;
  url?: string | null;
  text?: string | null;
  truncated?: boolean;
  logs?: { name: string; url: string; sizeBytes?: number }[];
}
interface EnvVar {
  name: string;
  value: string;
  /** Build phase: "runtime" (default, injected onto the running site) or "build"
   *  (passed to the build only). Absent ⇒ runtime. */
  scope?: "runtime" | "build";
}

/** True when two vars share identity (name + effective scope). A name may exist
 *  once per scope, so edit/delete must match on both. */
function sameEnvVar(
  a: EnvVar,
  b: { name: string; scope: "runtime" | "build" },
) {
  return a.name === b.name && (a.scope ?? "runtime") === b.scope;
}
/** Secrets are listed by NAME only — values are write-only and never returned.
 *  `origin`: "control-plane" (in the CP store) or "worker" (bound on the CF
 *  Worker out-of-band, e.g. `wrangler secret put` — shown for visibility). */
interface Secret {
  name: string;
  origin?: "control-plane" | "worker";
  /** Build phase: "runtime" (runtime bundle / CF Worker store) or "build"
   *  (mounted by the build Job only). Absent ⇒ runtime. */
  scope?: "runtime" | "build";
  boundOnWorker?: boolean;
}
interface Redirect {
  id?: string;
  from: string;
  to: string;
  type?: "permanent" | "temporary";
  source?: string;
}
interface Domain {
  host: string;
  canonical?: boolean;
  /** Neutral, client-facing status from the BFF (the substrate is hidden). */
  status?: "active" | "pending" | "action-required";
  /** A stable code for extra context (e.g. `zone-not-onboarded`), i18n-mapped. */
  detail?: string;
  /** The exact registrar records to create, computed by the BFF. */
  dns?: { type: string; name: string; value: string }[];
}
interface DomainsResult {
  dnsTemplate?: { type: string; name: string; value: string }[];
  items?: Domain[];
}

type Translate = ReturnType<typeof useT>;

// --- helpers ----------------------------------------------------------------

function list<T>(data: unknown, key: string): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object") {
    const v = (data as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v as T[];
  }
  return [];
}

/** Studio never shows the substrate — only the client-facing framework. */
function frameworkLabel(slug: string | null | undefined): string | null {
  if (slug === "deco-deno") return "Deco Deno";
  if (slug === "deco-tanstack") return "Deco TanStack";
  return slug ?? null;
}

function statusVariant(
  s: string | null | undefined,
): "success" | "destructive" | "warning" | "secondary" {
  const v = (s ?? "").toLowerCase();
  if (v.includes("ready") || v.includes("success") || v.includes("active")) {
    return "success";
  }
  if (v.includes("fail") || v.includes("error")) return "destructive";
  if (v.includes("build") || v.includes("pend") || v.includes("progress")) {
    return "warning";
  }
  return "secondary";
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return "—";
  const secs = Math.round((Date.now() - ms) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(secs) >= size)
      return rtf.format(-Math.round(secs / size), unit);
  }
  return rtf.format(-secs, "second");
}

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(secs >= 10 ? 0 : 1)}s`;
  const mins = Math.floor(secs / 60);
  const rem = Math.round(secs % 60);
  return `${mins}m ${rem}s`;
}

/** The pre-token condition: the upstream (or its proxy) answers 401. Rendered as
 *  a calm "not connected" state, not a red error. */
function isUnauthorized(error: unknown): boolean {
  const m = error instanceof Error ? error.message.toLowerCase() : "";
  return m.includes("unauthorized") || m.includes("401");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function Section({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {typeof count === "number" && count > 0 && (
          <Badge variant="secondary" className="tabular-nums">
            {count}
          </Badge>
        )}
        {action && <div className="ml-auto">{action}</div>}
      </header>
      <div className="p-2">{children}</div>
    </section>
  );
}

function RowsSkeleton({ cols }: { cols: number }) {
  return (
    <div className="flex flex-col gap-2 p-2">
      {[0, 1, 2].map((r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className="h-4 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 py-6 text-sm text-muted-foreground">{children}</div>
  );
}

// --- deploy -----------------------------------------------------------------

function DeployButton({
  base,
  orgSlug,
  site,
}: {
  base: string;
  orgSlug: string;
  site: string;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);

  const deployMutation = useMutation({
    mutationFn: () => mutateJson(`${base}/deploy`, "POST", { mode: "current" }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: KEYS.hostingDeployments(orgSlug, site),
      });
      // The deploy also produces a new history event — refresh that table too,
      // otherwise it stays stale until the next manual reload.
      queryClient.invalidateQueries({
        queryKey: KEYS.hostingDeploymentHistory(orgSlug, site),
      });
      toast.success(t("mainPanelTabs.hostingTab.toastDeployQueued"));
      setConfirm(false);
    },
    onError: (error) => toast.error(errorText(error)),
  });

  return (
    <>
      <Button
        size="sm"
        onClick={() => setConfirm(true)}
        disabled={deployMutation.isPending}
        aria-label={
          deployMutation.isPending
            ? t("mainPanelTabs.hostingTab.deploying")
            : t("mainPanelTabs.hostingTab.deploy")
        }
      >
        <Rocket01 className="size-4" />
        <span className="@max-sm/main-topbar:hidden">
          {deployMutation.isPending
            ? t("mainPanelTabs.hostingTab.deploying")
            : t("mainPanelTabs.hostingTab.deploy")}
        </span>
      </Button>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("mainPanelTabs.hostingTab.deployConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("mainPanelTabs.hostingTab.deployConfirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deployMutation.isPending}>
              {t("mainPanelTabs.hostingTab.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                deployMutation.mutate();
              }}
              disabled={deployMutation.isPending}
            >
              {t("mainPanelTabs.hostingTab.deploy")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// --- deployments (history + live marker + build logs) -----------------------

function actionBadge(action: string | null | undefined, t: Translate) {
  const a = (action ?? "").toLowerCase();
  if (a.includes("rollback")) {
    return (
      <Badge variant="warning">
        <FlipBackward className="size-3" />
        {t("mainPanelTabs.hostingTab.actionRollback")}
      </Badge>
    );
  }
  if (a.includes("redeploy")) {
    return (
      <Badge variant="secondary">
        <RefreshCw02 className="size-3" />
        {t("mainPanelTabs.hostingTab.actionRedeploy")}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary">
      <Rocket01 className="size-3" />
      {t("mainPanelTabs.hostingTab.actionDeploy")}
    </Badge>
  );
}

/** The deploy-event KIND (build / fast-deploy / deploy). Legacy rows carry no
 *  `type`, so fall back to the action badge to keep them meaningful. */
function typeBadge(
  type: string | null | undefined,
  action: string | null | undefined,
  t: Translate,
) {
  const ty = (type ?? "").toLowerCase();
  if (ty === "build") {
    return (
      <Badge variant="secondary">
        <FileCode02 className="size-3" />
        {t("mainPanelTabs.hostingTab.typeBuild")}
      </Badge>
    );
  }
  if (ty === "fast-deploy") {
    return (
      <Badge variant="secondary">
        <Zap className="size-3" />
        {t("mainPanelTabs.hostingTab.typeFastDeploy")}
      </Badge>
    );
  }
  if (ty === "deploy") {
    return (
      <Badge variant="secondary">
        <Rocket01 className="size-3" />
        {t("mainPanelTabs.hostingTab.typeDeploy")}
      </Badge>
    );
  }
  return actionBadge(action, t);
}

/** The deploy-event OUTCOME. Omitted on legacy rows that carry no `outcome`.
 *  `pending` is a calm neutral "in progress", not a warning. */
function outcomeBadge(outcome: string | null | undefined, t: Translate) {
  const o = (outcome ?? "").toLowerCase();
  if (o === "success") {
    return (
      <Badge variant="success">
        {t("mainPanelTabs.hostingTab.outcomeSuccess")}
      </Badge>
    );
  }
  if (o === "failure") {
    return (
      <Badge variant="destructive">
        {t("mainPanelTabs.hostingTab.outcomeFailure")}
      </Badge>
    );
  }
  if (o === "pending") {
    return (
      <Badge variant="secondary">
        <Clock className="size-3" />
        {t("mainPanelTabs.hostingTab.outcomePending")}
      </Badge>
    );
  }
  return null;
}

/** Build-logs dialog. Re-fetches on every open (staleTime/gcTime 0) because the
 *  presigned `url` expires ~5min — the URL is never cached. */
function BuildLogsDialog({
  base,
  orgSlug,
  site,
  target,
  onOpenChange,
}: {
  base: string;
  orgSlug: string;
  site: string;
  /** The commit/env whose logs to show, or null when the dialog is closed. */
  target: { commit: string; env: string } | null;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const open = target != null;
  const commit = target?.commit ?? "";
  const env = target?.env ?? "";

  const logsQuery = useQuery({
    queryKey: KEYS.hostingBuildLogs(orgSlug, site, commit, env),
    queryFn: () =>
      fetchJson(
        `${base}/deployments/logs?commit=${encodeURIComponent(
          commit,
        )}&env=${encodeURIComponent(env)}`,
      ),
    enabled: open && Boolean(commit),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
  });

  const data = logsQuery.data as BuildLogs | undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t("mainPanelTabs.hostingTab.buildLogsTitle")}
          </DialogTitle>
        </DialogHeader>
        <p className="font-mono text-xs text-muted-foreground">
          {t("mainPanelTabs.hostingTab.buildLogsCommit", {
            commit: commit.slice(0, 7),
          })}
        </p>

        {isUnauthorized(logsQuery.error) ? (
          <EmptyState
            icon={<Server01 className="size-5" />}
            title={t("mainPanelTabs.hostingTab.notConnectedTitle")}
            description={t("mainPanelTabs.hostingTab.notConnectedDescription")}
          />
        ) : logsQuery.isLoading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : logsQuery.error ? (
          <Muted>{t("mainPanelTabs.hostingTab.buildLogsError")}</Muted>
        ) : data && data.configured === false ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-muted/30 px-4 py-8 text-center">
            <AlertCircle className="size-5 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">
              {t("mainPanelTabs.hostingTab.buildLogsNotWiredTitle")}
            </p>
            <p className="text-xs text-muted-foreground">
              {data.reason ??
                t("mainPanelTabs.hostingTab.buildLogsNotWiredDescription")}
            </p>
          </div>
        ) : data?.text ? (
          <div className="flex flex-col gap-2">
            <pre className="max-h-[52vh] overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-foreground/80 whitespace-pre-wrap break-words">
              {data.text}
            </pre>
            {data.truncated && (
              <p className="text-xs text-warning">
                {t("mainPanelTabs.hostingTab.buildLogsTruncated")}
              </p>
            )}
            {data.url && (
              <a
                href={data.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex w-fit items-center gap-1.5 text-xs text-primary hover:underline"
              >
                <LinkExternal01 className="size-3.5" />
                {t("mainPanelTabs.hostingTab.buildLogsOpenFull")}
              </a>
            )}
          </div>
        ) : data?.url ? (
          <a
            href={data.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex w-fit items-center gap-1.5 text-sm text-primary hover:underline"
          >
            <LinkExternal01 className="size-4" />
            {t("mainPanelTabs.hostingTab.buildLogsOpenFull")}
          </a>
        ) : (
          <Muted>{t("mainPanelTabs.hostingTab.buildLogsEmpty")}</Muted>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DeploymentsSection({
  base,
  orgSlug,
  site,
  enabled,
  deployments,
  isLoading,
  error,
}: {
  base: string;
  orgSlug: string;
  site: string;
  enabled: boolean;
  deployments: Deployment[];
  isLoading: boolean;
  error: unknown;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [logsTarget, setLogsTarget] = useState<{
    commit: string;
    env: string;
  } | null>(null);

  const historyQuery = useQuery({
    queryKey: KEYS.hostingDeploymentHistory(orgSlug, site),
    queryFn: () => fetchJson(`${base}/deployments/history?limit=50`),
    enabled,
    retry: false,
    staleTime: 30_000,
  });
  const history = list<DeploymentHistoryEvent>(historyQuery.data, "items");

  // LIVE marker: the serving deployment is the one currently `up`; its commit is
  // what the site actually serves. Any history event on that same commit is the
  // live one.
  const servingCommit =
    deployments.find((d) => d.up === true)?.commitSha ??
    deployments.find((d) => d.production === true && d.up)?.commitSha ??
    null;

  const openLogs = (commit: string | null | undefined, env?: string | null) => {
    if (!commit) return;
    setLogsTarget({ commit, env: env ?? "production" });
  };

  return (
    <>
      {/* Current deployments */}
      <Section
        title={t("mainPanelTabs.hostingTab.deployments")}
        count={deployments.length}
      >
        {isLoading ? (
          <RowsSkeleton cols={5} />
        ) : error ? (
          <Muted>{t("mainPanelTabs.hostingTab.deploymentsError")}</Muted>
        ) : deployments.length === 0 ? (
          <Muted>{t("mainPanelTabs.hostingTab.noDeployments")}</Muted>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("mainPanelTabs.hostingTab.colCommit")}</TableHead>
                <TableHead>{t("mainPanelTabs.hostingTab.colStatus")}</TableHead>
                <TableHead>
                  {t("mainPanelTabs.hostingTab.colFramework")}
                </TableHead>
                <TableHead className="text-right">
                  {t("mainPanelTabs.hostingTab.colDuration")}
                </TableHead>
                <TableHead className="text-right">
                  {t("mainPanelTabs.hostingTab.colUpdated")}
                </TableHead>
                <TableHead className="w-[1%]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {deployments.map((d) => {
                const hasMessage = Boolean(d.buildMessage);
                const isExpanded = expanded === d.id;
                return (
                  <Fragment key={d.id}>
                    <TableRow>
                      <TableCell className="align-middle">
                        <div className="flex items-center gap-1.5">
                          {hasMessage ? (
                            <button
                              type="button"
                              onClick={() =>
                                setExpanded(isExpanded ? null : d.id)
                              }
                              aria-label={t(
                                "mainPanelTabs.hostingTab.showBuildMessage",
                              )}
                              className="text-muted-foreground hover:text-foreground"
                            >
                              {isExpanded ? (
                                <ChevronDown className="size-4" />
                              ) : (
                                <ChevronRight className="size-4" />
                              )}
                            </button>
                          ) : (
                            <GitCommit className="size-4 text-muted-foreground/60" />
                          )}
                          <span className="font-mono text-xs">
                            {d.shortCommit ?? d.commitSha?.slice(0, 7) ?? "—"}
                          </span>
                          {d.production === true && (
                            <Badge variant="outline">
                              {t("mainPanelTabs.hostingTab.production")}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="align-middle">
                        <div className="flex items-center gap-1.5">
                          <Badge variant={statusVariant(d.phase)}>
                            {d.phase ?? "—"}
                          </Badge>
                          {d.up === true && (
                            <Badge variant="success">
                              {t("mainPanelTabs.hostingTab.live")}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="align-middle text-xs text-muted-foreground">
                        {frameworkLabel(d.framework) ?? "—"}
                      </TableCell>
                      <TableCell className="text-right align-middle font-mono text-xs text-muted-foreground tabular-nums">
                        {fmtDuration(d.durationMs)}
                      </TableCell>
                      <TableCell className="text-right align-middle text-xs text-muted-foreground whitespace-nowrap">
                        {timeAgo(d.finishedAt ?? d.startedAt ?? d.createdAt)}
                      </TableCell>
                      <TableCell className="text-right align-middle">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={t("mainPanelTabs.hostingTab.buildLogs")}
                          onClick={() => openLogs(d.commitSha, d.env)}
                          disabled={!d.commitSha}
                        >
                          <FileCode02 className="size-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                    {hasMessage && isExpanded && (
                      <TableRow>
                        <TableCell colSpan={6} className="bg-muted/10">
                          <p className="whitespace-pre-wrap break-words px-2 py-1 font-mono text-xs text-muted-foreground">
                            {d.buildMessage}
                          </p>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Section>

      {/* Deploy history (timeline) */}
      <Section
        title={t("mainPanelTabs.hostingTab.deployHistory")}
        count={history.length}
      >
        {historyQuery.isLoading ? (
          <RowsSkeleton cols={4} />
        ) : historyQuery.error ? (
          <Muted>{t("mainPanelTabs.hostingTab.deployHistoryError")}</Muted>
        ) : history.length === 0 ? (
          <EmptyState
            icon={<Rocket01 className="size-5" />}
            title={t("mainPanelTabs.hostingTab.noDeployHistory")}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("mainPanelTabs.hostingTab.colAction")}</TableHead>
                <TableHead>{t("mainPanelTabs.hostingTab.colCommit")}</TableHead>
                <TableHead>
                  {t("mainPanelTabs.hostingTab.colFramework")}
                </TableHead>
                <TableHead>{t("mainPanelTabs.hostingTab.colActor")}</TableHead>
                <TableHead className="text-right">
                  {t("mainPanelTabs.hostingTab.colDate")}
                </TableHead>
                <TableHead className="w-[1%]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.map((h) => {
                const isLive =
                  Boolean(servingCommit) && h.commitSha === servingCommit;
                return (
                  <TableRow key={h.id}>
                    <TableCell className="align-middle">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {typeBadge(h.type, h.action, t)}
                        {outcomeBadge(h.outcome, t)}
                      </div>
                    </TableCell>
                    <TableCell className="align-middle">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-xs">
                          {h.commitSha?.slice(0, 7) ?? "—"}
                        </span>
                        {isLive && (
                          <Badge variant="success">
                            {t("mainPanelTabs.hostingTab.live")}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="align-middle text-xs text-muted-foreground">
                      {frameworkLabel(h.framework) ?? "—"}
                    </TableCell>
                    <TableCell className="align-middle text-xs text-muted-foreground">
                      {h.actor ?? "—"}
                    </TableCell>
                    <TableCell className="text-right align-middle text-xs text-muted-foreground whitespace-nowrap">
                      <span className="inline-flex items-center gap-1">
                        <Clock className="size-3" />
                        {timeAgo(h.createdAt)}
                      </span>
                    </TableCell>
                    <TableCell className="text-right align-middle">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t("mainPanelTabs.hostingTab.buildLogs")}
                        onClick={() => openLogs(h.commitSha, h.env)}
                        disabled={!h.commitSha}
                      >
                        <FileCode02 className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Section>

      <BuildLogsDialog
        base={base}
        orgSlug={orgSlug}
        site={site}
        target={logsTarget}
        onOpenChange={(open) => {
          if (!open) setLogsTarget(null);
        }}
      />
    </>
  );
}

// --- environment variables --------------------------------------------------

function EnvSection({
  base,
  orgSlug,
  site,
  envVars,
  codeVars,
  isLoading,
  error,
}: {
  base: string;
  orgSlug: string;
  site: string;
  envVars: EnvVar[];
  codeVars: EnvVar[];
  isLoading: boolean;
  error: unknown;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [addName, setAddName] = useState("");
  const [addValue, setAddValue] = useState("");
  const [addScope, setAddScope] = useState<"runtime" | "build">("runtime");
  const [editingKey, setEditingKey] = useState<{
    name: string;
    scope: "runtime" | "build";
  } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{
    name: string;
    scope: "runtime" | "build";
  } | null>(null);

  // The control-plane PUT is a REPLACE-SET: the body is the complete desired
  // list, so every add/edit/delete recomputes it from `envVars` and PUTs.
  const envMutation = useMutation({
    mutationFn: (vars: EnvVar[]) => mutateJson(`${base}/env`, "PUT", { vars }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: KEYS.hostingEnv(orgSlug, site),
      });
      toast.success(t("mainPanelTabs.hostingTab.toastEnvSaved"));
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const handleAdd = () => {
    const name = addName.trim();
    if (!name) {
      toast.error(t("mainPanelTabs.hostingTab.errorEnvNameRequired"));
      return;
    }
    // A name may exist once per scope, so the dup check is per (name, scope).
    if (envVars.some((v) => sameEnvVar(v, { name, scope: addScope }))) {
      toast.error(t("mainPanelTabs.hostingTab.errorEnvNameDuplicate"));
      return;
    }
    envMutation.mutate(
      [...envVars, { name, value: addValue, scope: addScope }],
      {
        onSuccess: () => {
          setAddName("");
          setAddValue("");
          setAddScope("runtime");
        },
      },
    );
  };

  const handleSaveEdit = (target: {
    name: string;
    scope: "runtime" | "build";
  }) => {
    envMutation.mutate(
      envVars.map((v) =>
        sameEnvVar(v, target)
          ? { name: target.name, value: editValue, scope: target.scope }
          : v,
      ),
      { onSuccess: () => setEditingKey(null) },
    );
  };

  const handleConfirmDelete = () => {
    if (!deleteTarget) return;
    envMutation.mutate(
      envVars.filter((v) => !sameEnvVar(v, deleteTarget)),
      { onSuccess: () => setDeleteTarget(null) },
    );
  };

  return (
    <Section title={t("mainPanelTabs.hostingTab.env")} count={envVars.length}>
      {isLoading ? (
        <RowsSkeleton cols={2} />
      ) : error ? (
        <Muted>{t("mainPanelTabs.hostingTab.envError")}</Muted>
      ) : (
        <div className="flex flex-col gap-2">
          {envVars.length === 0 ? (
            <Muted>{t("mainPanelTabs.hostingTab.noEnv")}</Muted>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("mainPanelTabs.hostingTab.colName")}</TableHead>
                  <TableHead>
                    {t("mainPanelTabs.hostingTab.colValue")}
                  </TableHead>
                  <TableHead className="w-[1%]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {envVars.map((e) => {
                  const escope = e.scope === "build" ? "build" : "runtime";
                  const isEditing =
                    editingKey?.name === e.name && editingKey?.scope === escope;
                  return (
                    <TableRow key={`${e.name}:${escope}`}>
                      <TableCell className="font-mono text-xs align-middle">
                        <span className="inline-flex items-center gap-2">
                          {e.name}
                          <Badge
                            variant={
                              escope === "build" ? "outline" : "secondary"
                            }
                            className="font-sans text-[10px] capitalize"
                          >
                            {escope === "build"
                              ? t("mainPanelTabs.hostingTab.secretScopeBuild")
                              : t(
                                  "mainPanelTabs.hostingTab.secretScopeRuntime",
                                )}
                          </Badge>
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground max-w-[360px] align-middle">
                        {isEditing ? (
                          <div className="flex items-center gap-2">
                            <Input
                              value={editValue}
                              onChange={(ev) => setEditValue(ev.target.value)}
                              className="h-7 font-mono text-xs"
                            />
                            <Button
                              size="xs"
                              onClick={() =>
                                handleSaveEdit({ name: e.name, scope: escope })
                              }
                              disabled={envMutation.isPending}
                            >
                              {t("mainPanelTabs.hostingTab.save")}
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => setEditingKey(null)}
                              disabled={envMutation.isPending}
                            >
                              {t("mainPanelTabs.hostingTab.cancel")}
                            </Button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setEditingKey({ name: e.name, scope: escope });
                              setEditValue(e.value);
                            }}
                            className="block w-full truncate text-left hover:underline"
                            aria-label={t("mainPanelTabs.hostingTab.editValue")}
                          >
                            {e.value}
                          </button>
                        )}
                      </TableCell>
                      <TableCell className="text-right align-middle">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={t(
                            "mainPanelTabs.hostingTab.deleteVariable",
                          )}
                          onClick={() =>
                            setDeleteTarget({ name: e.name, scope: escope })
                          }
                          disabled={envMutation.isPending}
                        >
                          <Trash01 className="size-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}

          {/* Inline add-variable row */}
          <div className="flex items-center gap-2 px-2 py-1">
            <Input
              placeholder={t("mainPanelTabs.hostingTab.envNamePlaceholder")}
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              className="h-8 flex-1 font-mono text-xs"
            />
            <Input
              placeholder={t("mainPanelTabs.hostingTab.envValuePlaceholder")}
              value={addValue}
              onChange={(e) => setAddValue(e.target.value)}
              className="h-8 flex-1 font-mono text-xs"
            />
            <Select
              value={addScope}
              onValueChange={(v) =>
                setAddScope(v === "build" ? "build" : "runtime")
              }
              disabled={envMutation.isPending}
            >
              <SelectTrigger className="h-8 w-[110px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="runtime">
                  {t("mainPanelTabs.hostingTab.secretScopeRuntime")}
                </SelectItem>
                <SelectItem value="build">
                  {t("mainPanelTabs.hostingTab.secretScopeBuild")}
                </SelectItem>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              aria-label={t("mainPanelTabs.hostingTab.addVariable")}
              onClick={handleAdd}
              disabled={envMutation.isPending || !addName.trim()}
            >
              <Plus className="size-4" />
              {t("mainPanelTabs.hostingTab.add")}
            </Button>
          </div>

          {/* Read-only vars declared in the repo wrangler.jsonc (code vars). Not
              editable here; a platform var above with the same name overrides. */}
          {codeVars.length > 0 && (
            <div className="mt-3 flex flex-col gap-1.5 border-t border-border pt-3">
              <p className="px-2 text-xs text-muted-foreground">
                {t("mainPanelTabs.hostingTab.codeVarsHint")}
              </p>
              <Table>
                <TableBody>
                  {codeVars.map((e) => (
                    <TableRow key={e.name}>
                      <TableCell className="font-mono text-xs align-middle">
                        {e.name}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground max-w-[360px] truncate align-middle">
                        {e.value}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}

      <AlertDialog
        open={deleteTarget != null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("mainPanelTabs.hostingTab.confirmDeleteVariableTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("mainPanelTabs.hostingTab.confirmDeleteVariableDescription", {
                name: deleteTarget?.name ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={envMutation.isPending}>
              {t("mainPanelTabs.hostingTab.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                handleConfirmDelete();
              }}
              disabled={envMutation.isPending}
            >
              {t("mainPanelTabs.hostingTab.deleteVariable")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}

// --- secrets ----------------------------------------------------------------

function SecretsSection({
  base,
  orgSlug,
  site,
  secrets,
  isLoading,
  error,
}: {
  base: string;
  orgSlug: string;
  site: string;
  secrets: Secret[];
  isLoading: boolean;
  error: unknown;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [addValue, setAddValue] = useState("");
  const [addScope, setAddScope] = useState<"runtime" | "build">("runtime");
  const [deleteTarget, setDeleteTarget] = useState<{
    name: string;
    scope: "runtime" | "build";
  } | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: KEYS.hostingSecrets(orgSlug, site),
    });

  const putMutation = useMutation({
    mutationFn: (input: {
      name: string;
      value: string;
      scope: "runtime" | "build";
    }) => mutateJson(`${base}/secrets`, "PUT", input),
    onSuccess: () => {
      invalidate();
      toast.success(t("mainPanelTabs.hostingTab.toastSecretSaved"));
      setAddOpen(false);
      setAddName("");
      setAddValue("");
      setAddScope("runtime");
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const deleteMutation = useMutation({
    // A name may exist in both scopes, so DELETE carries the scope as a query param.
    mutationFn: (target: { name: string; scope: "runtime" | "build" }) =>
      mutateJson(
        `${base}/secrets/${encodeURIComponent(target.name)}?scope=${target.scope}`,
        "DELETE",
      ),
    onSuccess: () => {
      invalidate();
      toast.success(t("mainPanelTabs.hostingTab.toastSecretDeleted"));
      setDeleteTarget(null);
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const handleAdd = () => {
    const name = addName.trim();
    if (!name) {
      toast.error(t("mainPanelTabs.hostingTab.errorSecretNameRequired"));
      return;
    }
    if (!addValue) {
      toast.error(t("mainPanelTabs.hostingTab.errorSecretValueRequired"));
      return;
    }
    putMutation.mutate({ name, value: addValue, scope: addScope });
  };

  const addButton = (
    <Button size="sm" variant="secondary" onClick={() => setAddOpen(true)}>
      <Plus className="size-4" />
      {t("mainPanelTabs.hostingTab.addSecret")}
    </Button>
  );

  return (
    <Section
      title={t("mainPanelTabs.hostingTab.secrets")}
      count={secrets.length}
      action={addButton}
    >
      {isLoading ? (
        <RowsSkeleton cols={2} />
      ) : error ? (
        <Muted>{t("mainPanelTabs.hostingTab.secretsError")}</Muted>
      ) : secrets.length === 0 ? (
        <Muted>{t("mainPanelTabs.hostingTab.noSecrets")}</Muted>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("mainPanelTabs.hostingTab.colName")}</TableHead>
              <TableHead>{t("mainPanelTabs.hostingTab.colValue")}</TableHead>
              <TableHead className="w-[1%]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {secrets.map((s) => {
              const scope = s.scope === "build" ? "build" : "runtime";
              return (
                <TableRow key={`${s.name}:${scope}`}>
                  <TableCell className="font-mono text-xs align-middle">
                    <span className="inline-flex items-center gap-2">
                      {s.name}
                      <Badge
                        variant={scope === "build" ? "outline" : "secondary"}
                        className="font-sans text-[10px] capitalize"
                      >
                        {scope === "build"
                          ? t("mainPanelTabs.hostingTab.secretScopeBuild")
                          : t("mainPanelTabs.hostingTab.secretScopeRuntime")}
                      </Badge>
                      {s.origin === "worker" && (
                        <Badge
                          variant="secondary"
                          className="font-sans text-[10px]"
                        >
                          {t("mainPanelTabs.hostingTab.secretOnWorker")}
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground align-middle">
                    {t("mainPanelTabs.hostingTab.secretValueHidden")}
                  </TableCell>
                  <TableCell className="text-right align-middle">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("mainPanelTabs.hostingTab.deleteSecret")}
                      onClick={() => setDeleteTarget({ name: s.name, scope })}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash01 className="size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {/* Add secret dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("mainPanelTabs.hostingTab.addSecretTitle")}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="secret-name">
                {t("mainPanelTabs.hostingTab.colName")}
              </Label>
              <Input
                id="secret-name"
                placeholder={t(
                  "mainPanelTabs.hostingTab.secretNamePlaceholder",
                )}
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                className="font-mono text-xs"
                disabled={putMutation.isPending}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="secret-value">
                {t("mainPanelTabs.hostingTab.colValue")}
              </Label>
              <Input
                id="secret-value"
                type="password"
                placeholder={t(
                  "mainPanelTabs.hostingTab.secretValuePlaceholder",
                )}
                value={addValue}
                onChange={(e) => setAddValue(e.target.value)}
                className="font-mono text-xs"
                disabled={putMutation.isPending}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label>{t("mainPanelTabs.hostingTab.secretScope")}</Label>
              <Select
                value={addScope}
                onValueChange={(v) =>
                  setAddScope(v === "build" ? "build" : "runtime")
                }
                disabled={putMutation.isPending}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="runtime">
                    {t("mainPanelTabs.hostingTab.secretScopeRuntime")}
                  </SelectItem>
                  <SelectItem value="build">
                    {t("mainPanelTabs.hostingTab.secretScopeBuild")}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {addScope === "build"
                  ? t("mainPanelTabs.hostingTab.secretScopeBuildHint")
                  : t("mainPanelTabs.hostingTab.secretScopeRuntimeHint")}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              onClick={() => setAddOpen(false)}
              disabled={putMutation.isPending}
            >
              {t("mainPanelTabs.hostingTab.cancel")}
            </Button>
            <Button
              type="button"
              onClick={handleAdd}
              disabled={putMutation.isPending || !addName.trim() || !addValue}
            >
              {putMutation.isPending
                ? t("mainPanelTabs.hostingTab.saving")
                : t("mainPanelTabs.hostingTab.add")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete secret confirm */}
      <AlertDialog
        open={deleteTarget != null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("mainPanelTabs.hostingTab.confirmDeleteSecretTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("mainPanelTabs.hostingTab.confirmDeleteSecretDescription", {
                name: deleteTarget?.name ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              {t("mainPanelTabs.hostingTab.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                if (deleteTarget) deleteMutation.mutate(deleteTarget);
              }}
              disabled={deleteMutation.isPending}
            >
              {t("mainPanelTabs.hostingTab.deleteSecret")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}

// --- redirects --------------------------------------------------------------

// The redirect ingress runs on eks-hub (namespace `deco-redirect-system`); its
// NLB has three FIXED Elastic IPs. A host redirect only activates once its
// `from` host resolves to these, so the UI must tell the user which A records
// to add at their registrar. Same constant the admin + control-plane DNS panels
// use — kept in sync by hand (there is no endpoint that returns it).
const REDIRECT_APEX_EIPS = [
  "16.148.147.194",
  "52.32.122.94",
  "52.35.156.199",
] as const;

/** A bare apex host (`example.com`, two labels) vs a subdomain
 *  (`old.example.com`). The redirect ingress accepts either once its DNS points
 *  at the EIPs; apex hosts conventionally use the `@` record name. */
function isApexHost(host: string): boolean {
  return host.replace(/\.$/, "").split(".").filter(Boolean).length === 2;
}

function redirectRecordName(host: string): string {
  return isApexHost(host) ? "@" : host;
}

function CopyValueButton({ value, t }: { value: string; t: Translate }) {
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={t("mainPanelTabs.hostingTab.dnsCopy")}
      onClick={() => {
        void navigator.clipboard?.writeText(value);
        toast.success(t("mainPanelTabs.hostingTab.dnsCopied"));
      }}
    >
      <Copy01 className="size-3.5" />
    </Button>
  );
}

/** Registrar DNS instructions to activate a host redirect: the `from` host must
 *  resolve to the redirect ingress's three fixed EIPs. `source === "both"` means
 *  the redirect is already observed live on the cluster; anything else is still
 *  pending its DNS. */
function RedirectDnsPanel({
  from,
  source,
  t,
}: {
  from: string;
  source?: string;
  t: Translate;
}) {
  const host = from.trim().replace(/\.$/, "");
  const name = host ? redirectRecordName(host) : "@";
  const active = source === "both";
  return (
    <div className="flex flex-col gap-3 rounded-md border bg-muted/30 p-3">
      <div className="flex items-center gap-2">
        <Globe01 className="size-4 text-muted-foreground" />
        <span className="text-xs font-medium">
          {t("mainPanelTabs.hostingTab.dnsSetupTitle")}
        </span>
        <Badge variant={active ? "secondary" : "outline"} className="ml-auto">
          {active
            ? t("mainPanelTabs.hostingTab.dnsActive")
            : t("mainPanelTabs.hostingTab.dnsAwaiting")}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("mainPanelTabs.hostingTab.dnsRedirectIntent", {
          from: host || "—",
        })}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("mainPanelTabs.hostingTab.dnsSetupDescription", {
          host: host || "—",
        })}
      </p>
      <p className="text-xs text-muted-foreground">
        {active
          ? t("mainPanelTabs.hostingTab.dnsActiveHint")
          : t("mainPanelTabs.hostingTab.dnsAwaitingHint")}
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("mainPanelTabs.hostingTab.dnsColType")}</TableHead>
            <TableHead>{t("mainPanelTabs.hostingTab.dnsColName")}</TableHead>
            <TableHead>{t("mainPanelTabs.hostingTab.dnsColValue")}</TableHead>
            <TableHead className="w-[1%]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {REDIRECT_APEX_EIPS.map((ip) => (
            <TableRow key={ip}>
              <TableCell className="font-mono text-xs align-middle">
                A
              </TableCell>
              <TableCell className="font-mono text-xs align-middle">
                {name}
              </TableCell>
              <TableCell className="font-mono text-xs align-middle">
                {ip}
              </TableCell>
              <TableCell className="text-right align-middle">
                <CopyValueButton value={ip} t={t} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function RedirectTypeBadge({ type, t }: { type?: string; t: Translate }) {
  return (
    <Badge variant={type === "permanent" ? "secondary" : "outline"}>
      {type === "permanent"
        ? t("mainPanelTabs.hostingTab.permanent")
        : t("mainPanelTabs.hostingTab.temporary")}
    </Badge>
  );
}

function RedirectsSection({
  base,
  orgSlug,
  site,
  redirects,
  isLoading,
  error,
}: {
  base: string;
  orgSlug: string;
  site: string;
  redirects: Redirect[];
  isLoading: boolean;
  error: unknown;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  // null = add mode; a string = editing that (immutable) `from`.
  const [editingFrom, setEditingFrom] = useState<string | null>(null);
  const [formFrom, setFormFrom] = useState("");
  const [formTo, setFormTo] = useState("");
  const [formType, setFormType] = useState<"permanent" | "temporary">(
    "permanent",
  );
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  // Which redirect's registrar DNS instructions are expanded (`from` value).
  const [dnsOpenFrom, setDnsOpenFrom] = useState<string | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: KEYS.hostingRedirects(orgSlug, site),
    });

  // PUT is idempotent per `from` — it upserts the redirect for that source, so
  // the same call powers both add and edit.
  const putMutation = useMutation({
    mutationFn: (input: {
      from: string;
      to: string;
      type: "permanent" | "temporary";
    }) => mutateJson(`${base}/redirects`, "PUT", input),
    onSuccess: () => {
      invalidate();
      toast.success(t("mainPanelTabs.hostingTab.toastRedirectSaved"));
      setDialogOpen(false);
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: (from: string) =>
      mutateJson(`${base}/redirects/${encodeURIComponent(from)}`, "DELETE"),
    onSuccess: () => {
      invalidate();
      toast.success(t("mainPanelTabs.hostingTab.toastRedirectDeleted"));
      setDeleteTarget(null);
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const openAdd = () => {
    setEditingFrom(null);
    setFormFrom("");
    setFormTo("");
    setFormType("permanent");
    setDialogOpen(true);
  };

  const openEdit = (r: Redirect) => {
    setEditingFrom(r.from);
    setFormFrom(r.from);
    setFormTo(r.to);
    setFormType(r.type === "temporary" ? "temporary" : "permanent");
    setDialogOpen(true);
  };

  const handleSave = () => {
    const from = formFrom.trim();
    const to = formTo.trim();
    if (!from || !to) {
      toast.error(t("mainPanelTabs.hostingTab.errorRedirectFieldsRequired"));
      return;
    }
    putMutation.mutate({ from, to, type: formType });
  };

  const addButton = (
    <Button size="sm" variant="secondary" onClick={openAdd}>
      <Plus className="size-4" />
      {t("mainPanelTabs.hostingTab.addRedirect")}
    </Button>
  );

  return (
    <Section
      title={t("mainPanelTabs.hostingTab.redirects")}
      count={redirects.length}
      action={addButton}
    >
      {isLoading ? (
        <RowsSkeleton cols={3} />
      ) : error ? (
        <Muted>{t("mainPanelTabs.hostingTab.redirectsError")}</Muted>
      ) : redirects.length === 0 ? (
        <EmptyState
          icon={<CornerUpRight className="size-5" />}
          title={t("mainPanelTabs.hostingTab.noRedirects")}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("mainPanelTabs.hostingTab.colFrom")}</TableHead>
              <TableHead>{t("mainPanelTabs.hostingTab.colTo")}</TableHead>
              <TableHead>{t("mainPanelTabs.hostingTab.colType")}</TableHead>
              <TableHead className="w-[1%]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {redirects.map((r, i) => (
              <Fragment key={r.id ?? `${r.from}-${i}`}>
                <TableRow>
                  <TableCell className="font-mono text-xs align-middle">
                    {r.from}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground max-w-[280px] truncate align-middle">
                    {r.to}
                  </TableCell>
                  <TableCell className="align-middle">
                    <RedirectTypeBadge type={r.type} t={t} />
                  </TableCell>
                  <TableCell className="text-right align-middle whitespace-nowrap">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("mainPanelTabs.hostingTab.dnsSetup")}
                      onClick={() =>
                        setDnsOpenFrom(dnsOpenFrom === r.from ? null : r.from)
                      }
                    >
                      <Globe01 className="size-4" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("mainPanelTabs.hostingTab.editRedirect")}
                      onClick={() => openEdit(r)}
                      disabled={putMutation.isPending}
                    >
                      <Pencil01 className="size-4" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("mainPanelTabs.hostingTab.deleteRedirect")}
                      onClick={() => setDeleteTarget(r.from)}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash01 className="size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
                {dnsOpenFrom === r.from && (
                  <TableRow>
                    <TableCell colSpan={4} className="bg-muted/10">
                      <RedirectDnsPanel from={r.from} source={r.source} t={t} />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      )}

      {/* Add / edit redirect dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingFrom != null
                ? t("mainPanelTabs.hostingTab.editRedirectTitle")
                : t("mainPanelTabs.hostingTab.addRedirectTitle")}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="redirect-from">
                {t("mainPanelTabs.hostingTab.colFrom")}
              </Label>
              <Input
                id="redirect-from"
                placeholder={t(
                  "mainPanelTabs.hostingTab.redirectFromPlaceholder",
                )}
                value={formFrom}
                onChange={(e) => setFormFrom(e.target.value)}
                className="font-mono text-xs"
                // `from` is the redirect's identity; editing changes to/type only.
                disabled={editingFrom != null || putMutation.isPending}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="redirect-to">
                {t("mainPanelTabs.hostingTab.colTo")}
              </Label>
              <Input
                id="redirect-to"
                placeholder={t(
                  "mainPanelTabs.hostingTab.redirectToPlaceholder",
                )}
                value={formTo}
                onChange={(e) => setFormTo(e.target.value)}
                className="font-mono text-xs"
                disabled={putMutation.isPending}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label>{t("mainPanelTabs.hostingTab.colType")}</Label>
              <Select
                value={formType}
                onValueChange={(v) =>
                  setFormType(v === "temporary" ? "temporary" : "permanent")
                }
                disabled={putMutation.isPending}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="permanent">
                    {t("mainPanelTabs.hostingTab.permanent")}
                  </SelectItem>
                  <SelectItem value="temporary">
                    {t("mainPanelTabs.hostingTab.temporary")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            {formFrom.trim() && (
              <RedirectDnsPanel
                from={formFrom}
                source={redirects.find((r) => r.from === editingFrom)?.source}
                t={t}
              />
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              onClick={() => setDialogOpen(false)}
              disabled={putMutation.isPending}
            >
              {t("mainPanelTabs.hostingTab.cancel")}
            </Button>
            <Button
              type="button"
              onClick={handleSave}
              disabled={
                putMutation.isPending || !formFrom.trim() || !formTo.trim()
              }
            >
              {putMutation.isPending
                ? t("mainPanelTabs.hostingTab.saving")
                : t("mainPanelTabs.hostingTab.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete redirect confirm */}
      <AlertDialog
        open={deleteTarget != null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("mainPanelTabs.hostingTab.confirmDeleteRedirectTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("mainPanelTabs.hostingTab.confirmDeleteRedirectDescription", {
                from: deleteTarget ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              {t("mainPanelTabs.hostingTab.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                if (deleteTarget) deleteMutation.mutate(deleteTarget);
              }}
              disabled={deleteMutation.isPending}
            >
              {t("mainPanelTabs.hostingTab.deleteRedirect")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}

// --- domains ----------------------------------------------------------------

interface DnsRecord {
  type: string;
  name: string;
  value: string;
}

/** The registrar records to create, exactly as the control-plane BFF computed
 *  them (substrate-correct, substrate-hidden). Studio only renders them. */
function DomainDnsPanel({
  records,
  t,
}: {
  records: DnsRecord[];
  t: Translate;
}) {
  if (records.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-md border bg-muted/30 p-3">
      <div className="flex items-center gap-2">
        <Globe01 className="size-4 text-muted-foreground" />
        <span className="text-xs font-medium">
          {t("mainPanelTabs.hostingTab.dnsSetupTitle")}
        </span>
      </div>
      {/* Records can be long (host + value): let the cells wrap (break-all) so
          the table fits the dialog width instead of forcing it wider. A copy
          button carries the exact value, so wrapping the display is fine. */}
      <Table className="w-full table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-14">
              {t("mainPanelTabs.hostingTab.dnsColType")}
            </TableHead>
            <TableHead>{t("mainPanelTabs.hostingTab.dnsColName")}</TableHead>
            <TableHead>{t("mainPanelTabs.hostingTab.dnsColValue")}</TableHead>
            <TableHead className="w-8" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {records.map((r) => (
            <TableRow key={`${r.type}-${r.name}-${r.value}`}>
              <TableCell className="font-mono text-xs align-top">
                {r.type}
              </TableCell>
              <TableCell className="break-all font-mono text-xs align-top">
                {r.name}
              </TableCell>
              <TableCell className="break-all font-mono text-xs align-top">
                {r.value}
              </TableCell>
              <TableCell className="text-right align-top">
                <CopyValueButton value={r.value} t={t} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** Neutral, client-facing status — the control-plane hides which substrate wired
 *  the domain; we show only whether it's live, provisioning, or needs action. */
function DomainStatusBadge({ domain, t }: { domain: Domain; t: Translate }) {
  const status = domain.status ?? "pending";
  const label =
    status === "active"
      ? t("mainPanelTabs.hostingTab.statusActive")
      : status === "action-required"
        ? t("mainPanelTabs.hostingTab.statusActionRequired")
        : t("mainPanelTabs.hostingTab.statusPending");
  const detail =
    domain.detail === "zone-not-onboarded"
      ? t("mainPanelTabs.hostingTab.detailZoneNotOnboarded")
      : undefined;
  return (
    <Badge
      variant={status === "active" ? "secondary" : "outline"}
      title={detail}
    >
      {label}
    </Badge>
  );
}

function DomainsSection({
  base,
  orgSlug,
  site,
  domains,
  dnsTemplate,
  isLoading,
  error,
}: {
  base: string;
  orgSlug: string;
  site: string;
  domains: Domain[];
  dnsTemplate: DnsRecord[];
  isLoading: boolean;
  error: unknown;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [formHost, setFormHost] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [dnsOpenHost, setDnsOpenHost] = useState<string | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: KEYS.hostingDomains(orgSlug, site),
    });

  const putMutation = useMutation({
    mutationFn: (input: { host: string }) =>
      mutateJson(`${base}/domains`, "PUT", input),
    onSuccess: () => {
      invalidate();
      toast.success(t("mainPanelTabs.hostingTab.toastDomainSaved"));
      setDialogOpen(false);
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: (host: string) =>
      mutateJson(`${base}/domains/${encodeURIComponent(host)}`, "DELETE"),
    onSuccess: () => {
      invalidate();
      toast.success(t("mainPanelTabs.hostingTab.toastDomainDeleted"));
      setDeleteTarget(null);
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const openAdd = () => {
    setFormHost("");
    setDialogOpen(true);
  };

  const handleSave = () => {
    const host = formHost.trim().toLowerCase();
    if (!host) {
      toast.error(t("mainPanelTabs.hostingTab.errorDomainHostRequired"));
      return;
    }
    putMutation.mutate({ host });
  };

  // The attach-form DNS preview: the site's substrate-correct template with the
  // record name swapped to the host the operator is typing.
  const previewRecords = dnsTemplate.map((r) => ({
    ...r,
    name: formHost.trim().toLowerCase() || r.name,
  }));

  const addButton = (
    <Button size="sm" variant="secondary" onClick={openAdd}>
      <Plus className="size-4" />
      {t("mainPanelTabs.hostingTab.addDomain")}
    </Button>
  );

  return (
    <Section
      title={t("mainPanelTabs.hostingTab.domains")}
      count={domains.length}
      action={addButton}
    >
      {isLoading ? (
        <RowsSkeleton cols={3} />
      ) : error ? (
        <Muted>{t("mainPanelTabs.hostingTab.domainsError")}</Muted>
      ) : domains.length === 0 ? (
        <EmptyState
          icon={<Globe01 className="size-5" />}
          title={t("mainPanelTabs.hostingTab.noDomains")}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("mainPanelTabs.hostingTab.colHost")}</TableHead>
              <TableHead>{t("mainPanelTabs.hostingTab.colStatus")}</TableHead>
              <TableHead className="w-[1%]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {domains.map((d, i) => (
              <Fragment key={`${d.host}-${i}`}>
                <TableRow>
                  <TableCell className="font-mono text-xs align-middle">
                    {d.host}
                    {d.canonical && (
                      <Badge variant="outline" className="ml-2">
                        {t("mainPanelTabs.hostingTab.canonical")}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="align-middle">
                    <DomainStatusBadge domain={d} t={t} />
                  </TableCell>
                  <TableCell className="text-right align-middle whitespace-nowrap">
                    {!d.canonical && (
                      <>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={t("mainPanelTabs.hostingTab.dnsSetup")}
                          onClick={() =>
                            setDnsOpenHost(
                              dnsOpenHost === d.host ? null : d.host,
                            )
                          }
                        >
                          <Globe01 className="size-4" />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={t(
                            "mainPanelTabs.hostingTab.deleteDomain",
                          )}
                          onClick={() => setDeleteTarget(d.host)}
                          disabled={deleteMutation.isPending}
                        >
                          <Trash01 className="size-4" />
                        </Button>
                      </>
                    )}
                  </TableCell>
                </TableRow>
                {dnsOpenHost === d.host && (
                  <TableRow>
                    <TableCell colSpan={3} className="bg-muted/10">
                      <DomainDnsPanel records={d.dns ?? []} t={t} />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      )}

      {/* Add domain dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("mainPanelTabs.hostingTab.addDomainTitle")}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="domain-host">
                {t("mainPanelTabs.hostingTab.colHost")}
              </Label>
              <Input
                id="domain-host"
                placeholder={t(
                  "mainPanelTabs.hostingTab.domainHostPlaceholder",
                )}
                value={formHost}
                onChange={(e) => setFormHost(e.target.value)}
                className="font-mono text-xs"
                disabled={putMutation.isPending}
              />
            </div>
            {formHost.trim() && (
              <DomainDnsPanel records={previewRecords} t={t} />
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              onClick={() => setDialogOpen(false)}
              disabled={putMutation.isPending}
            >
              {t("mainPanelTabs.hostingTab.cancel")}
            </Button>
            <Button
              type="button"
              onClick={handleSave}
              disabled={putMutation.isPending || !formHost.trim()}
            >
              {putMutation.isPending
                ? t("mainPanelTabs.hostingTab.saving")
                : t("mainPanelTabs.hostingTab.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete domain confirm */}
      <AlertDialog
        open={deleteTarget != null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("mainPanelTabs.hostingTab.confirmDeleteDomainTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("mainPanelTabs.hostingTab.confirmDeleteDomainDescription", {
                host: deleteTarget ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              {t("mainPanelTabs.hostingTab.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                if (deleteTarget) deleteMutation.mutate(deleteTarget);
              }}
              disabled={deleteMutation.isPending}
            >
              {t("mainPanelTabs.hostingTab.deleteDomain")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}

// --- tab --------------------------------------------------------------------

export function HostingTab({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const { org } = useProjectContext();
  const entity = useVirtualMCP(virtualMcpId);
  const siteSlug = resolveAgentSiteSlug(entity);
  const enabled = Boolean(siteSlug);
  const base = siteSlug
    ? `/api/${org.slug}/hosting/${encodeURIComponent(siteSlug)}`
    : "";

  const deploymentsQuery = useQuery({
    queryKey: KEYS.hostingDeployments(org.slug, siteSlug ?? ""),
    queryFn: () => fetchJson(`${base}/deployments`),
    enabled,
    retry: false,
    staleTime: 30_000,
  });
  const envQuery = useQuery({
    queryKey: KEYS.hostingEnv(org.slug, siteSlug ?? ""),
    queryFn: () => fetchJson(`${base}/env`),
    enabled,
    retry: false,
    staleTime: 30_000,
  });
  const secretsQuery = useQuery({
    queryKey: KEYS.hostingSecrets(org.slug, siteSlug ?? ""),
    queryFn: () => fetchJson(`${base}/secrets`),
    enabled,
    retry: false,
    staleTime: 30_000,
  });
  const redirectsQuery = useQuery({
    queryKey: KEYS.hostingRedirects(org.slug, siteSlug ?? ""),
    queryFn: () => fetchJson(`${base}/redirects`),
    enabled,
    retry: false,
    staleTime: 30_000,
  });
  const domainsQuery = useQuery({
    queryKey: KEYS.hostingDomains(org.slug, siteSlug ?? ""),
    queryFn: () => fetchJson(`${base}/domains`),
    enabled,
    retry: false,
    staleTime: 30_000,
  });

  if (!siteSlug) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <EmptyState
          icon={<Server01 className="size-5" />}
          title={t("mainPanelTabs.hostingTab.noSiteTitle")}
          description={t("mainPanelTabs.hostingTab.noSiteDescription")}
        />
      </div>
    );
  }

  // Pre-token / not-connected: when the proxy answers 401 across the board, show
  // one calm configuration state instead of red errors.
  const allUnauthorized =
    isUnauthorized(deploymentsQuery.error) &&
    isUnauthorized(envQuery.error) &&
    isUnauthorized(redirectsQuery.error);
  if (allUnauthorized) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <EmptyState
          icon={<Server01 className="size-5" />}
          title={t("mainPanelTabs.hostingTab.notConnectedTitle")}
          description={t("mainPanelTabs.hostingTab.notConnectedDescription")}
        />
      </div>
    );
  }

  const deployments = list<Deployment>(deploymentsQuery.data, "items");
  const envVars = list<EnvVar>(envQuery.data, "vars");
  const codeVars = list<EnvVar>(envQuery.data, "codeVars");
  const secrets = list<Secret>(secretsQuery.data, "secrets");
  const redirects = list<Redirect>(redirectsQuery.data, "items");
  const domainsData = domainsQuery.data as DomainsResult | undefined;
  const domains = domainsData?.items ?? [];
  const dnsTemplate = domainsData?.dnsTemplate ?? [];
  const framework = frameworkLabel(
    deployments.find((d) => d.framework)?.framework,
  );

  return (
    <>
      <Main.Topbar.Right.Portal>
        <DeployButton base={base} orgSlug={org.slug} site={siteSlug} />
      </Main.Topbar.Right.Portal>
      <div className="h-full min-h-0 overflow-y-auto">
        <Main.Container width="standard" className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm text-muted-foreground">
              {t("mainPanelTabs.hostingTab.subtitle", { site: siteSlug })}
            </p>
            {framework && <Badge variant="secondary">{framework}</Badge>}
          </div>

          {/* Deployments — current + history timeline + build logs */}
          <DeploymentsSection
            base={base}
            orgSlug={org.slug}
            site={siteSlug}
            enabled={enabled}
            deployments={deployments}
            isLoading={deploymentsQuery.isLoading}
            error={deploymentsQuery.error}
          />

          {/* Environment variables (interactive) */}
          <EnvSection
            base={base}
            orgSlug={org.slug}
            site={siteSlug}
            envVars={envVars}
            codeVars={codeVars}
            isLoading={envQuery.isLoading}
            error={envQuery.error}
          />

          {/* Secrets (interactive; names only) */}
          <SecretsSection
            base={base}
            orgSlug={org.slug}
            site={siteSlug}
            secrets={secrets}
            isLoading={secretsQuery.isLoading}
            error={secretsQuery.error}
          />

          {/* Custom domains (per-substrate: knative DecoDomain vs CF Worker Route) */}
          <DomainsSection
            base={base}
            orgSlug={org.slug}
            site={siteSlug}
            domains={domains}
            dnsTemplate={dnsTemplate}
            isLoading={domainsQuery.isLoading}
            error={domainsQuery.error}
          />

          {/* Redirects (interactive) */}
          <RedirectsSection
            base={base}
            orgSlug={org.slug}
            site={siteSlug}
            redirects={redirects}
            isLoading={redirectsQuery.isLoading}
            error={redirectsQuery.error}
          />
        </Main.Container>
      </div>
    </>
  );
}
