/**
 * E2eTab — per-site end-to-end run view (control-plane BFF proxy).
 *
 * Master/detail: a runs table (Run / Status / Command / Started / Summary +
 * per-row delete) whose rows open a rich, native run-detail Sheet
 * (`e2e-run-detail.tsx`). A run is queued from the header via a small dialog
 * whose type Select is populated from `GET /e2e/types`.
 *
 * All traffic flows through the same server-side proxy that powers Hosting — at
 * `/api/:org/hosting/:site/e2e/*` — so the control-plane service token never
 * reaches the browser; the client only sees the proxied JSON. When the proxy
 * answers 401 across the board the tab shows one calm "not connected" state.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckDone01,
  ChevronDown,
  ChevronRight,
  HelpCircle,
  PlayCircle,
  Trash01,
} from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
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
import { E2eRunDetail, type E2eRunListItem } from "./e2e-run-detail.tsx";

// --- control-plane REST DTOs (client-safe fields only) ---------------------

type E2eRun = E2eRunListItem;

interface E2eType {
  id: string;
  label?: string;
  description?: string;
}

/** A declared check + its LIVE phase (observed DecoE2E `.status`). Distinct from a
 *  finished S3 run — a check shows up here as pending/running immediately. */
interface E2eCheck {
  subject?: string;
  url?: string;
  command?: string;
  schedule?: string | null;
  phase?: string | null;
  updatedAt?: string;
}

type Translate = ReturnType<typeof useT>;

/** The schedule presets in the Run-test dialog. `"once"` is a sentinel (Radix
 *  Select forbids an empty value) → sent as no schedule; the rest are cron. */
const SCHEDULE_ONCE = "once";
const SCHEDULE_PRESETS: Array<{
  value: string;
  labelKey: Parameters<Translate>[0];
}> = [
  { value: SCHEDULE_ONCE, labelKey: "mainPanelTabs.e2eTab.scheduleOnce" },
  { value: "0 * * * *", labelKey: "mainPanelTabs.e2eTab.scheduleHourly" },
  { value: "0 8 * * *", labelKey: "mainPanelTabs.e2eTab.scheduleDaily" },
  { value: "0 8 * * 1", labelKey: "mainPanelTabs.e2eTab.scheduleWeekly" },
];

/** Map the observed DecoE2E phase to a badge. Phase = did the check RUN (not the
 *  site's pass/fail — that verdict lives on the finished run). */
function PhaseBadge({
  phase,
  t,
}: {
  phase: string | null | undefined;
  t: Translate;
}) {
  const p = (phase ?? "").toLowerCase();
  if (p === "running") {
    return (
      <Badge variant="warning">{t("mainPanelTabs.e2eTab.statusRunning")}</Badge>
    );
  }
  if (p === "succeeded") {
    return (
      <Badge variant="secondary">{t("mainPanelTabs.e2eTab.phaseRan")}</Badge>
    );
  }
  if (p === "failed") {
    return (
      <Badge variant="destructive">
        {t("mainPanelTabs.e2eTab.phaseErrored")}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary">{t("mainPanelTabs.e2eTab.phasePending")}</Badge>
  );
}

// --- helpers ----------------------------------------------------------------

function list<T>(data: unknown, key: string): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object") {
    const v = (data as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v as T[];
  }
  return [];
}

function statusVariant(
  s: string | null | undefined,
): "success" | "destructive" | "warning" | "secondary" {
  const v = (s ?? "").toLowerCase();
  if (v.includes("pass") || v.includes("success") || v.includes("ok")) {
    return "success";
  }
  if (v.includes("fail") || v.includes("error")) return "destructive";
  if (v.includes("run") || v.includes("pend") || v.includes("progress")) {
    return "warning";
  }
  return "secondary";
}

function statusLabel(s: string | null | undefined, t: Translate) {
  const variant = statusVariant(s);
  if (variant === "success") return t("mainPanelTabs.e2eTab.statusPassed");
  if (variant === "destructive") return t("mainPanelTabs.e2eTab.statusFailed");
  if (variant === "warning") return t("mainPanelTabs.e2eTab.statusRunning");
  return s ?? "—";
}

/** Summary column: exit code + file count when present. */
function summaryLabel(run: E2eRun, t: Translate): string {
  const parts: string[] = [];
  const exit = run.summary?.exitCode;
  if (typeof exit === "number") {
    parts.push(
      t("mainPanelTabs.e2eTab.summaryExitCode", { code: String(exit) }),
    );
  }
  const files = run.summary?.fileCount;
  if (typeof files === "number") {
    parts.push(
      t("mainPanelTabs.e2eTab.summaryFiles", { count: String(files) }),
    );
  }
  return parts.length > 0 ? parts.join(" · ") : "—";
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
  children,
}: {
  title: string;
  count?: number;
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

// --- run-test dialog --------------------------------------------------------

function RunTestButton({
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
  const [open, setOpen] = useState(false);
  const [command, setCommand] = useState<string>("");
  const [schedule, setSchedule] = useState<string>(SCHEDULE_ONCE);

  // Types are fetched lazily — only once the dialog opens.
  const typesQuery = useQuery({
    queryKey: KEYS.e2eTypes(orgSlug, site),
    queryFn: () => fetchJson(`${base}/e2e/types`),
    enabled: open,
    retry: false,
    staleTime: 60_000,
  });
  const types = list<E2eType>(typesQuery.data, "items");

  const runMutation = useMutation({
    mutationFn: (input: { command: string; schedule: string }) => {
      // The sentinel one-shot sends no schedule; a cron string makes it recurring.
      const cron = input.schedule === SCHEDULE_ONCE ? "" : input.schedule;
      return mutateJson(`${base}/e2e/runs`, "POST", {
        command: input.command,
        ...(cron ? { schedule: cron } : {}),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: KEYS.e2eRuns(orgSlug, site),
      });
      // The check appears immediately (pending) — refresh the live Checks list.
      queryClient.invalidateQueries({
        queryKey: KEYS.e2eChecks(orgSlug, site),
      });
      toast.success(t("mainPanelTabs.e2eTab.toastRunQueued"));
      setOpen(false);
      setCommand("");
      setSchedule(SCHEDULE_ONCE);
    },
    onError: (error) => toast.error(errorText(error)),
  });

  const selected = types.find((ty) => ty.id === command);

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <PlayCircle className="size-4" />
        {t("mainPanelTabs.e2eTab.runTest")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("mainPanelTabs.e2eTab.runTestTitle")}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              {t("mainPanelTabs.e2eTab.runTestDescription")}
            </p>
            <div className="flex flex-col gap-2">
              <Label>{t("mainPanelTabs.e2eTab.selectType")}</Label>
              {typesQuery.isLoading ? (
                <Skeleton className="h-9 w-full" />
              ) : typesQuery.error ? (
                <p className="text-xs text-destructive">
                  {t("mainPanelTabs.e2eTab.typesError")}
                </p>
              ) : types.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("mainPanelTabs.e2eTab.noTypes")}
                </p>
              ) : (
                <Select value={command} onValueChange={setCommand}>
                  <SelectTrigger className="w-full">
                    <SelectValue
                      placeholder={t(
                        "mainPanelTabs.e2eTab.selectTypePlaceholder",
                      )}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {types.map((ty) => (
                      // Single-line label only: Radix mirrors the selected item's
                      // content into the (fixed-height) trigger, so a two-line
                      // label+description would overflow it. The selected type's
                      // description is shown on its own line below the Select.
                      <SelectItem
                        key={ty.id}
                        value={ty.id}
                        textValue={ty.label ?? ty.id}
                      >
                        <span className="text-sm">{ty.label ?? ty.id}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {selected?.description && (
                <p className="text-xs text-muted-foreground">
                  {selected.description}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <Label>{t("mainPanelTabs.e2eTab.scheduleLabel")}</Label>
              <Select value={schedule} onValueChange={setSchedule}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCHEDULE_PRESETS.map((p) => (
                    <SelectItem key={p.value || "once"} value={p.value}>
                      {t(p.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              onClick={() => setOpen(false)}
              disabled={runMutation.isPending}
            >
              {t("mainPanelTabs.e2eTab.cancel")}
            </Button>
            <Button
              type="button"
              onClick={() =>
                command && runMutation.mutate({ command, schedule })
              }
              disabled={!command || runMutation.isPending}
            >
              {runMutation.isPending
                ? t("mainPanelTabs.e2eTab.running")
                : t("mainPanelTabs.e2eTab.runConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// --- tab --------------------------------------------------------------------

/** Collapsible "how to use" help — use-facing only (what E2E runs, the check
 *  types, how to run one, what a result shows). No infra internals. */
function E2eHelp() {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        <HelpCircle className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">
          {t("mainPanelTabs.e2eTab.helpTitle")}
        </span>
        {open ? (
          <ChevronDown className="ml-auto size-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="ml-auto size-4 text-muted-foreground" />
        )}
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t border-border px-4 py-3 text-sm text-muted-foreground">
          <p>{t("mainPanelTabs.e2eTab.helpIntro")}</p>
          <p>{t("mainPanelTabs.e2eTab.helpTypes")}</p>
          <p>{t("mainPanelTabs.e2eTab.helpRun")}</p>
          <p>{t("mainPanelTabs.e2eTab.helpResults")}</p>
        </div>
      )}
    </div>
  );
}

// --- checks (declared checks + live phase) ----------------------------------

/** The site's DECLARED checks with their LIVE phase (observed DecoE2E `.status`).
 *  Unlike the Runs table (finished S3 runs), a check shows up here as
 *  pending/running the moment it is triggered. Polls while anything is in flight. */
function ChecksSection({
  base,
  orgSlug,
  site,
  enabled,
}: {
  base: string;
  orgSlug: string;
  site: string;
  enabled: boolean;
}) {
  const t = useT();
  const query = useQuery({
    queryKey: KEYS.e2eChecks(orgSlug, site),
    queryFn: () => fetchJson(`${base}/e2e/checks`),
    enabled,
    retry: false,
    staleTime: 15_000,
    // Poll while any check is still in flight so pending → running → ran updates live.
    refetchInterval: (q) => {
      const items = list<E2eCheck>(q.state.data, "items");
      const inFlight = items.some((c) => {
        const p = (c.phase ?? "").toLowerCase();
        return p === "" || p === "running" || p === "pending";
      });
      return inFlight ? 5_000 : false;
    },
  });
  const checks = list<E2eCheck>(query.data, "items");

  return (
    <Section
      title={t("mainPanelTabs.e2eTab.checksSection")}
      count={checks.length}
    >
      {query.isLoading ? (
        <RowsSkeleton cols={5} />
      ) : query.error ? (
        <Muted>{t("mainPanelTabs.e2eTab.checksError")}</Muted>
      ) : checks.length === 0 ? (
        <EmptyState
          icon={<CheckDone01 className="size-5" />}
          title={t("mainPanelTabs.e2eTab.noChecks")}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("mainPanelTabs.e2eTab.colStatus")}</TableHead>
              <TableHead>{t("mainPanelTabs.e2eTab.colCommand")}</TableHead>
              <TableHead>{t("mainPanelTabs.e2eTab.colSchedule")}</TableHead>
              <TableHead>{t("mainPanelTabs.e2eTab.url")}</TableHead>
              <TableHead>{t("mainPanelTabs.e2eTab.colUpdated")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {checks.map((c, i) => (
              <TableRow key={`${c.subject ?? site}-${c.command ?? ""}-${i}`}>
                <TableCell>
                  <PhaseBadge phase={c.phase} t={t} />
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {c.command ?? "—"}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {c.schedule ? c.schedule : "—"}
                </TableCell>
                <TableCell className="max-w-[220px] truncate font-mono text-xs text-muted-foreground">
                  {c.url ?? "—"}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                  {timeAgo(c.updatedAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

export function E2eTab({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const { org } = useProjectContext();
  const entity = useVirtualMCP(virtualMcpId);
  const siteSlug = resolveAgentSiteSlug(entity);
  const enabled = Boolean(siteSlug);
  const base = siteSlug
    ? `/api/${org.slug}/hosting/${encodeURIComponent(siteSlug)}`
    : "";

  const queryClient = useQueryClient();
  const [selectedRun, setSelectedRun] = useState<E2eRun | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<E2eRun | null>(null);

  const runsQuery = useQuery({
    queryKey: KEYS.e2eRuns(org.slug, siteSlug ?? ""),
    queryFn: () => fetchJson(`${base}/e2e/runs`),
    enabled,
    retry: false,
    staleTime: 30_000,
  });

  const deleteMutation = useMutation({
    mutationFn: (runId: string) =>
      mutateJson(`${base}/e2e/runs/${encodeURIComponent(runId)}`, "DELETE"),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: KEYS.e2eRuns(org.slug, siteSlug ?? ""),
      });
      toast.success(t("mainPanelTabs.e2eTab.toastRunDeleted"));
      setDeleteTarget(null);
    },
    onError: (error) => toast.error(errorText(error)),
  });

  if (!siteSlug) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <EmptyState
          icon={<CheckDone01 className="size-5" />}
          title={t("mainPanelTabs.e2eTab.noSiteTitle")}
          description={t("mainPanelTabs.e2eTab.noSiteDescription")}
        />
      </div>
    );
  }

  // Pre-token / not-connected: the proxy answers 401 → one calm configuration
  // state instead of a red error.
  if (isUnauthorized(runsQuery.error)) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <EmptyState
          icon={<CheckDone01 className="size-5" />}
          title={t("mainPanelTabs.e2eTab.notConnectedTitle")}
          description={t("mainPanelTabs.e2eTab.notConnectedDescription")}
        />
      </div>
    );
  }

  const runs = list<E2eRun>(runsQuery.data, "items");

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <CheckDone01 className="size-[18px] text-muted-foreground" />
              <h2 className="text-base font-semibold text-foreground">
                {t("mainPanelTabs.e2eTab.title")}
              </h2>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("mainPanelTabs.e2eTab.subtitle", { site: siteSlug })}
            </p>
          </div>
          <RunTestButton base={base} orgSlug={org.slug} site={siteSlug} />
        </div>

        <E2eHelp />

        <ChecksSection
          base={base}
          orgSlug={org.slug}
          site={siteSlug}
          enabled={enabled}
        />

        <Section title={t("mainPanelTabs.e2eTab.runs")} count={runs.length}>
          {runsQuery.isLoading ? (
            <RowsSkeleton cols={5} />
          ) : runsQuery.error ? (
            <Muted>{t("mainPanelTabs.e2eTab.runsError")}</Muted>
          ) : runs.length === 0 ? (
            <EmptyState
              icon={<CheckDone01 className="size-5" />}
              title={t("mainPanelTabs.e2eTab.noRuns")}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("mainPanelTabs.e2eTab.colRun")}</TableHead>
                  <TableHead>{t("mainPanelTabs.e2eTab.colStatus")}</TableHead>
                  <TableHead>{t("mainPanelTabs.e2eTab.colCommand")}</TableHead>
                  <TableHead>{t("mainPanelTabs.e2eTab.colStarted")}</TableHead>
                  <TableHead>{t("mainPanelTabs.e2eTab.colSummary")}</TableHead>
                  <TableHead className="w-[1%]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => (
                  <TableRow
                    key={r.runId}
                    className="cursor-pointer"
                    onClick={() => setSelectedRun(r)}
                  >
                    <TableCell className="font-mono text-xs">
                      {r.runId}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(r.status)}>
                        {statusLabel(r.status, t)}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {r.summary?.command ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {timeAgo(r.startedAt)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap tabular-nums">
                      {summaryLabel(r, t)}
                    </TableCell>
                    <TableCell className="text-right align-middle">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t("mainPanelTabs.e2eTab.deleteRun")}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTarget(r);
                        }}
                        disabled={deleteMutation.isPending}
                      >
                        <Trash01 className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Section>
      </div>

      {/* Rich run detail (right-side sheet) */}
      <E2eRunDetail
        base={base}
        orgSlug={org.slug}
        site={siteSlug}
        run={selectedRun}
        onOpenChange={(open) => {
          if (!open) setSelectedRun(null);
        }}
      />

      {/* Delete run confirm */}
      <AlertDialog
        open={deleteTarget != null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("mainPanelTabs.e2eTab.confirmDeleteRunTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("mainPanelTabs.e2eTab.confirmDeleteRun", {
                runId: deleteTarget?.runId ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              {t("mainPanelTabs.e2eTab.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                if (deleteTarget) deleteMutation.mutate(deleteTarget.runId);
              }}
              disabled={deleteMutation.isPending}
            >
              {t("mainPanelTabs.e2eTab.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
