/**
 * E2eRunDetail — rich, native run-detail view for one E2E run.
 *
 * Rendered inside a right-side Sheet opened from the E2E runs table. Fetches
 * `GET /e2e/runs/:runId` fresh on every open (staleTime/gcTime 0,
 * refetchOnMount) because the report carries PRESIGNED artifact URLs
 * (screenshot / video / trace) that expire ~1h — they must never be cached.
 *
 * The response's `report` (when present) drives the whole view: a per-viewport
 * Tabs, each with a steps tree, Web Vitals tiles, collapsible Console/Network,
 * inline video, and a Playwright trace link. When `report` is null it degrades
 * to the flat `checks[]` table + `artifacts[]` download links. A 401 shows the
 * same calm "not connected" state the Hosting tab uses.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  Cursor01,
  LinkExternal01,
  MinusCircle,
  Monitor01,
  Terminal,
  VideoRecorder,
  XCircle,
} from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@decocms/ui/components/collapsible.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@decocms/ui/components/tabs.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@decocms/ui/components/table.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@decocms/ui/components/sheet.tsx";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";

type Translate = ReturnType<typeof useT>;

// --- control-plane REST DTOs (client-safe fields only) ---------------------

/** One row of the runs list — passed into the detail so its header can show the
 *  command / url / verdict immediately, before the detail request resolves. */
export interface E2eRunListItem {
  runId: string;
  status?: "pass" | "fail" | string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  summary?: {
    url?: string | null;
    command?: string | null;
    exitCode?: number | null;
    fileCount?: number | null;
  } | null;
}

interface E2eVitals {
  lcp?: number;
  cls?: number;
  fcp?: number;
  ttfb?: number;
  inp?: number;
}
interface E2eStep {
  step?: number;
  name?: string;
  status?: string;
  durationMs?: number;
  screenshotUrl?: string;
  actionDescription?: string;
  usedSelector?: string;
  errorDetail?: { slug?: string; expected?: string; suggestion?: string };
  critical?: boolean;
}
interface E2eConsoleEntry {
  type?: string;
  text?: string;
  location?: string;
}
interface E2eNetworkEntry {
  url?: string;
  method?: string;
  status?: number;
  resourceType?: string;
}
interface E2eViewportRun {
  viewport?: string;
  durationMs?: number;
  verdict?: string;
  /** Funnel-level verdict (distinct from the step verdict); shown when it differs. */
  funnelVerdict?: string;
  steps?: E2eStep[];
  console?: E2eConsoleEntry[];
  network?: E2eNetworkEntry[];
  videoUrl?: string;
  traceUrl?: string;
}
interface E2ePage {
  url?: string;
  viewport?: string;
  /** HTTP status the page load returned. */
  status?: number;
  vitals?: E2eVitals;
}
interface E2eReport {
  /** The runner platform the check ran on (e.g. "cloudflare"). */
  platform?: string;
  viewports?: string[];
  verdict?: string;
  totalDurationMs?: number;
  runs?: E2eViewportRun[];
  pages?: E2ePage[];
}
interface E2eCheck {
  name?: string;
  status?: string;
  viewport?: string;
  durationMs?: number;
}
interface E2eArtifact {
  name?: string;
  url?: string;
}
interface E2eRunDetailData {
  runId: string;
  status?: "pass" | "fail" | string | null;
  checks?: E2eCheck[];
  artifacts?: E2eArtifact[];
  report?: E2eReport | null;
}

// --- helpers ----------------------------------------------------------------

function isUnauthorized(error: unknown): boolean {
  const m = error instanceof Error ? error.message.toLowerCase() : "";
  return m.includes("unauthorized") || m.includes("401");
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

function fmtMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return ms >= 1000
    ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s`
    : `${Math.round(ms)}ms`;
}

function isPass(status: string | null | undefined): boolean {
  const s = (status ?? "").toLowerCase();
  return s === "pass" || s === "passed" || s === "ok" || s === "success";
}
function isFail(status: string | null | undefined): boolean {
  const s = (status ?? "").toLowerCase();
  return s === "fail" || s === "failed" || s === "error";
}
function isSkipped(status: string | null | undefined): boolean {
  const s = (status ?? "").toLowerCase();
  return s === "skip" || s === "skipped";
}

/** value used to key/select a viewport tab — never empty, always unique. */
function viewportValue(run: E2eViewportRun, index: number): string {
  return run.viewport && run.viewport.trim()
    ? run.viewport
    : `viewport-${index}`;
}

// --- verdict badge ----------------------------------------------------------

function VerdictBadge({
  status,
  t,
}: {
  status: string | null | undefined;
  t: Translate;
}) {
  if (isFail(status)) {
    return (
      <Badge variant="destructive">
        <XCircle className="size-3" />
        {t("mainPanelTabs.e2eTab.statusFailed")}
      </Badge>
    );
  }
  if (isPass(status)) {
    return (
      <Badge variant="success">
        <CheckCircle className="size-3" />
        {t("mainPanelTabs.e2eTab.statusPassed")}
      </Badge>
    );
  }
  return <Badge variant="secondary">{status ?? "—"}</Badge>;
}

function StepStatusIcon({ status }: { status: string | null | undefined }) {
  if (isPass(status))
    return <CheckCircle className="size-4 shrink-0 text-success" />;
  if (isFail(status))
    return <XCircle className="size-4 shrink-0 text-destructive" />;
  if (isSkipped(status))
    return <MinusCircle className="size-4 shrink-0 text-muted-foreground" />;
  return <Circle className="size-4 shrink-0 text-muted-foreground/60" />;
}

/** At-a-glance status strip: one status-toned dot per step. */
function stepDotClass(status: string | null | undefined): string {
  if (isPass(status)) return "bg-success";
  if (isFail(status)) return "bg-destructive";
  if (isSkipped(status)) return "bg-muted-foreground/40";
  return "bg-muted-foreground/25";
}
function StepDots({ steps }: { steps: E2eStep[] }) {
  if (steps.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {steps.map((s, i) => (
        <span
          key={i}
          title={s.name ?? `step ${i + 1}`}
          className={cn("size-1.5 rounded-full", stepDotClass(s.status))}
        />
      ))}
    </div>
  );
}

// --- web vitals -------------------------------------------------------------

const VITALS: Array<{
  key: keyof E2eVitals;
  label: string;
  good: number;
  poor: number;
  unit: "ms" | "cls";
}> = [
  { key: "lcp", label: "LCP", good: 2500, poor: 4000, unit: "ms" },
  { key: "inp", label: "INP", good: 200, poor: 500, unit: "ms" },
  { key: "cls", label: "CLS", good: 0.1, poor: 0.25, unit: "cls" },
  { key: "fcp", label: "FCP", good: 1800, poor: 3000, unit: "ms" },
  { key: "ttfb", label: "TTFB", good: 800, poor: 1800, unit: "ms" },
];

function VitalsTiles({ vitals }: { vitals: E2eVitals }) {
  const tiles = VITALS.filter(({ key }) => {
    const v = vitals[key];
    return v != null && Number.isFinite(v);
  });
  if (tiles.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {tiles.map(({ key, label, good, poor, unit }) => {
        const v = vitals[key] as number;
        const tone =
          v <= good
            ? "text-success"
            : v <= poor
              ? "text-warning"
              : "text-destructive";
        const shown = unit === "cls" ? v.toFixed(3) : fmtMs(v);
        return (
          <div
            key={key}
            className="flex flex-col gap-1 rounded-lg border border-border bg-muted/30 px-3 py-2"
          >
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {label}
            </span>
            <span
              className={cn(
                "font-mono text-sm font-semibold tabular-nums",
                tone,
              )}
            >
              {shown}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// --- collapsible sub-section ------------------------------------------------

function CollapsibleSection({
  icon,
  label,
  badge,
  defaultOpen = false,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  badge?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-left hover:bg-muted/40">
        {open ? (
          <ChevronDown className="size-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 text-muted-foreground" />
        )}
        {icon}
        <span className="text-sm font-medium text-foreground">{label}</span>
        {badge != null && <span className="ml-auto">{badge}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">{children}</CollapsibleContent>
    </Collapsible>
  );
}

// --- steps tree -------------------------------------------------------------

function StepRow({
  step,
  index,
  t,
}: {
  step: E2eStep;
  index: number;
  t: Translate;
}) {
  const failed = isFail(step.status);
  return (
    <li className="flex gap-3 py-2.5">
      <div className="flex flex-col items-center gap-1">
        <StepStatusIcon status={step.status} />
        <span className="font-mono text-[10px] text-muted-foreground/60 tabular-nums">
          {step.step ?? index + 1}
        </span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {step.name ??
              step.actionDescription ??
              `${t("mainPanelTabs.e2eTab.steps")} ${index + 1}`}
            {step.critical && (
              <Badge variant="warning" className="ml-2 align-middle">
                {t("mainPanelTabs.e2eTab.critical")}
              </Badge>
            )}
          </span>
          <span className="flex shrink-0 items-center gap-1 font-mono text-[11px] text-muted-foreground tabular-nums">
            <Clock className="size-3" />
            {fmtMs(step.durationMs)}
          </span>
        </div>
        {step.actionDescription && step.actionDescription !== step.name && (
          <p className="text-xs text-muted-foreground">
            {step.actionDescription}
          </p>
        )}
        {step.usedSelector && (
          <code className="flex w-fit items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/70">
            <Cursor01 className="size-3 text-muted-foreground" />
            {step.usedSelector}
          </code>
        )}
        {failed && step.errorDetail && (
          <div className="flex items-start gap-1.5 rounded-lg bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <div className="flex min-w-0 flex-col gap-0.5">
              {step.errorDetail.slug && (
                <span className="break-words">
                  {t("mainPanelTabs.e2eTab.missingSelector", {
                    slug: step.errorDetail.slug,
                  })}
                </span>
              )}
              {step.errorDetail.expected && (
                <span className="break-words text-destructive/80">
                  {t("mainPanelTabs.e2eTab.expected", {
                    value: step.errorDetail.expected,
                  })}
                </span>
              )}
              {step.errorDetail.suggestion && (
                <span className="break-words text-destructive/80">
                  {step.errorDetail.suggestion}
                </span>
              )}
            </div>
          </div>
        )}
        {step.screenshotUrl && (
          <a
            href={step.screenshotUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-1 w-fit"
            aria-label={t("mainPanelTabs.e2eTab.viewScreenshot")}
          >
            <img
              src={step.screenshotUrl}
              alt={step.name ?? `step ${index + 1}`}
              loading="lazy"
              className="max-h-44 rounded-lg border border-border"
            />
          </a>
        )}
      </div>
    </li>
  );
}

// --- console / network lists ------------------------------------------------

function ConsoleList({
  entries,
  t,
}: {
  entries: E2eConsoleEntry[];
  t: Translate;
}) {
  if (entries.length === 0) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground">
        {t("mainPanelTabs.e2eTab.noConsole")}
      </p>
    );
  }
  return (
    <div className="flex max-h-72 flex-col overflow-y-auto rounded-lg border border-border">
      {entries.map((e, i) => {
        const type = (e.type ?? "").toLowerCase();
        const tone =
          type === "error"
            ? "text-destructive"
            : type === "warning" || type === "warn"
              ? "text-warning"
              : "text-foreground/70";
        return (
          <div
            key={i}
            className="border-b border-border/60 px-2.5 py-1.5 font-mono text-[11px] last:border-b-0"
          >
            <span className={cn("break-words", tone)}>{e.text}</span>
          </div>
        );
      })}
    </div>
  );
}

function NetworkList({
  entries,
  t,
}: {
  entries: E2eNetworkEntry[];
  t: Translate;
}) {
  if (entries.length === 0) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground">
        {t("mainPanelTabs.e2eTab.noNetwork")}
      </p>
    );
  }
  return (
    <div className="flex max-h-72 flex-col overflow-y-auto rounded-lg border border-border">
      {entries.map((r, i) => {
        const bad = (r.status ?? 0) >= 400;
        return (
          <div
            key={i}
            className="flex items-center gap-2 border-b border-border/60 px-2.5 py-1.5 font-mono text-[11px] last:border-b-0"
          >
            <span
              className={cn(
                "tabular-nums",
                bad ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {r.status ?? "—"}
            </span>
            <span className="w-10 shrink-0 text-muted-foreground/70">
              {r.method}
            </span>
            <span className="min-w-0 flex-1 truncate text-foreground/70">
              {r.url}
            </span>
            {r.resourceType && (
              <span className="shrink-0 text-muted-foreground/50">
                {r.resourceType}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// --- one viewport panel -----------------------------------------------------

function ViewportPanel({
  run,
  page,
  t,
}: {
  run: E2eViewportRun;
  page?: E2ePage;
  t: Translate;
}) {
  const steps = run.steps ?? [];
  const failCount = steps.filter((s) => isFail(s.status)).length;
  const consoleEntries = run.console ?? [];
  const networkEntries = run.network ?? [];
  const consoleHasError = consoleEntries.some(
    (c) => (c.type ?? "").toLowerCase() === "error",
  );

  return (
    <div className="flex flex-col gap-4 pt-4">
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <VerdictBadge status={run.verdict} t={t} />
        {run.funnelVerdict && run.funnelVerdict !== run.verdict && (
          <span>
            {t("mainPanelTabs.e2eTab.funnel")}:{" "}
            <span className="font-medium text-foreground">
              {run.funnelVerdict}
            </span>
          </span>
        )}
        {run.durationMs != null && (
          <span className="flex items-center gap-1 tabular-nums">
            <Clock className="size-3" />
            {fmtMs(run.durationMs)}
          </span>
        )}
        {page?.status != null && (
          <Badge variant={page.status < 400 ? "secondary" : "destructive"}>
            HTTP {page.status}
          </Badge>
        )}
      </div>

      {steps.length > 0 && <StepDots steps={steps} />}

      {page?.vitals && (
        <section className="flex flex-col gap-2">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("mainPanelTabs.e2eTab.vitals")}
          </h4>
          <VitalsTiles vitals={page.vitals} />
        </section>
      )}

      {steps.length > 0 && (
        <CollapsibleSection
          defaultOpen
          icon={<CheckCircle className="size-4 text-muted-foreground" />}
          label={t("mainPanelTabs.e2eTab.steps")}
          badge={
            failCount > 0 ? (
              <Badge variant="destructive">
                {t("mainPanelTabs.e2eTab.failCount", {
                  count: String(failCount),
                })}
              </Badge>
            ) : (
              <Badge variant="secondary">
                {t("mainPanelTabs.e2eTab.stepsCount", {
                  count: String(steps.length),
                })}
              </Badge>
            )
          }
        >
          <ol className="divide-y divide-border/60 rounded-lg border border-border px-3">
            {steps.map((step, si) => (
              <StepRow key={si} step={step} index={si} t={t} />
            ))}
          </ol>
        </CollapsibleSection>
      )}

      {consoleEntries.length > 0 && (
        <CollapsibleSection
          icon={<Terminal className="size-4 text-muted-foreground" />}
          label={t("mainPanelTabs.e2eTab.console")}
          badge={
            <Badge variant={consoleHasError ? "destructive" : "secondary"}>
              {consoleEntries.length}
            </Badge>
          }
        >
          <ConsoleList entries={consoleEntries} t={t} />
        </CollapsibleSection>
      )}

      {networkEntries.length > 0 && (
        <CollapsibleSection
          icon={<Monitor01 className="size-4 text-muted-foreground" />}
          label={t("mainPanelTabs.e2eTab.network")}
          badge={<Badge variant="secondary">{networkEntries.length}</Badge>}
        >
          <NetworkList entries={networkEntries} t={t} />
        </CollapsibleSection>
      )}

      {run.videoUrl && (
        <CollapsibleSection
          icon={<VideoRecorder className="size-4 text-muted-foreground" />}
          label={t("mainPanelTabs.e2eTab.video")}
        >
          {/* biome-ignore lint/a11y/useMediaCaption: E2E session capture, no captions */}
          <video
            controls
            src={run.videoUrl}
            className="max-h-80 w-full rounded-lg border border-border"
          />
        </CollapsibleSection>
      )}

      {run.traceUrl && (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="secondary" asChild>
            {/* The public Playwright trace viewer fetches the trace.zip straight
                from the presigned URL — a client-side PWA, no server round-trip. */}
            <a
              href={`https://trace.playwright.dev/?trace=${encodeURIComponent(run.traceUrl)}`}
              target="_blank"
              rel="noreferrer"
            >
              <LinkExternal01 className="size-4" />
              {t("mainPanelTabs.e2eTab.openTrace")}
            </a>
          </Button>
          <a
            href={run.traceUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            {t("mainPanelTabs.e2eTab.downloadTrace")}
          </a>
        </div>
      )}
    </div>
  );
}

// --- artifacts (junit.xml, raw files, screenshots) --------------------------

/** Downloadable run artifacts. PNG artifacts render as an inline image grid
 *  (so reportless runs still show screenshots); everything else is a file link.
 *  When empty, shows a hint (used by the reportless fallback). */
function ArtifactsSection({
  artifacts,
  t,
}: {
  artifacts: E2eArtifact[];
  t: Translate;
}) {
  const images = artifacts.filter((a) => /\.png$/i.test(a.name ?? ""));
  const files = artifacts.filter((a) => !/\.png$/i.test(a.name ?? ""));
  return (
    <section className="flex flex-col gap-2">
      <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t("mainPanelTabs.e2eTab.artifacts")}
      </h4>
      {artifacts.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("mainPanelTabs.e2eTab.noArtifacts")}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {images.length > 0 && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {images.map((a, i) => (
                <a
                  key={`${a.name ?? "img"}-${i}`}
                  href={a.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={
                    a.name ?? t("mainPanelTabs.e2eTab.viewScreenshot")
                  }
                >
                  <img
                    src={a.url}
                    alt={a.name ?? "screenshot"}
                    loading="lazy"
                    className="w-full rounded-lg border border-border"
                  />
                </a>
              ))}
            </div>
          )}
          {files.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {files.map((a, i) => (
                <a
                  key={`${a.name ?? "artifact"}-${i}`}
                  href={a.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 font-mono text-[11px] text-foreground/80 hover:bg-muted/40"
                >
                  {a.name ?? t("mainPanelTabs.e2eTab.openArtifact")}
                  <LinkExternal01 className="size-3 text-muted-foreground" />
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// --- checks fallback (no rich report) ---------------------------------------

function ChecksFallback({
  checks,
  artifacts,
  t,
}: {
  checks: E2eCheck[];
  artifacts: E2eArtifact[];
  t: Translate;
}) {
  return (
    <div className="flex flex-col gap-5">
      {checks.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("mainPanelTabs.e2eTab.checksTitle")}
          </h4>
          <div className="rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("mainPanelTabs.e2eTab.colCheck")}</TableHead>
                  <TableHead>{t("mainPanelTabs.e2eTab.colStatus")}</TableHead>
                  <TableHead>{t("mainPanelTabs.e2eTab.colViewport")}</TableHead>
                  <TableHead className="text-right">
                    {t("mainPanelTabs.e2eTab.colDuration")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {checks.map((c, i) => (
                  <TableRow key={`${c.name ?? "check"}-${i}`}>
                    <TableCell className="text-xs text-foreground">
                      {c.name ?? "—"}
                    </TableCell>
                    <TableCell>
                      <VerdictBadge status={c.status} t={t} />
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {c.viewport ?? "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground tabular-nums">
                      {fmtMs(c.durationMs)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("mainPanelTabs.e2eTab.noReport")}
        </p>
      )}

      <ArtifactsSection artifacts={artifacts} t={t} />
    </div>
  );
}

// --- detail body ------------------------------------------------------------

function DetailBody({ data, t }: { data: E2eRunDetailData; t: Translate }) {
  const report = data.report ?? null;
  const runs = report?.runs ?? [];
  const checks = data.checks ?? [];
  const artifacts = data.artifacts ?? [];

  // Index each page capture by viewport so a tab can show its matching vitals.
  const pageByViewport = new Map<string, E2ePage>();
  for (const p of report?.pages ?? []) {
    if (p.viewport && !pageByViewport.has(p.viewport)) {
      pageByViewport.set(p.viewport, p);
    }
  }

  const firstRun = runs[0];
  if (report && firstRun) {
    return (
      <div className="flex flex-col gap-5">
        <Tabs variant="underline" defaultValue={viewportValue(firstRun, 0)}>
          <TabsList variant="underline" className="flex-wrap">
            {runs.map((run, i) => {
              const value = viewportValue(run, i);
              return (
                <TabsTrigger
                  key={value}
                  value={value}
                  variant="underline"
                  className="gap-1.5"
                >
                  {isFail(run.verdict) ? (
                    <XCircle className="size-3.5 text-destructive" />
                  ) : (
                    <CheckCircle className="size-3.5 text-success" />
                  )}
                  {run.viewport ??
                    `${t("mainPanelTabs.e2eTab.viewport")} ${i + 1}`}
                </TabsTrigger>
              );
            })}
          </TabsList>
          {runs.map((run, i) => {
            const value = viewportValue(run, i);
            return (
              <TabsContent key={value} value={value}>
                <ViewportPanel
                  run={run}
                  page={
                    run.viewport ? pageByViewport.get(run.viewport) : undefined
                  }
                  t={t}
                />
              </TabsContent>
            );
          })}
        </Tabs>
        {/* Raw artifacts (junit.xml, screenshots, …) stay reachable even with a
            rich report — otherwise the report branch hides them entirely. */}
        {artifacts.length > 0 && (
          <ArtifactsSection artifacts={artifacts} t={t} />
        )}
      </div>
    );
  }

  // report present but no per-viewport runs → show any page vitals + checks.
  const firstVitals = (report?.pages ?? []).find((p) => p.vitals)?.vitals;
  return (
    <div className="flex flex-col gap-5">
      {firstVitals && (
        <section className="flex flex-col gap-2">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("mainPanelTabs.e2eTab.vitals")}
          </h4>
          <VitalsTiles vitals={firstVitals} />
        </section>
      )}
      <ChecksFallback checks={checks} artifacts={artifacts} t={t} />
    </div>
  );
}

// --- sheet ------------------------------------------------------------------

export function E2eRunDetail({
  base,
  orgSlug,
  site,
  run,
  onOpenChange,
}: {
  base: string;
  orgSlug: string;
  site: string;
  /** The selected run row, or null when the sheet is closed. */
  run: E2eRunListItem | null;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const runId = run?.runId ?? "";
  const open = run != null;

  // Fetch fresh on every open: the presigned artifact URLs expire ~1h, so the
  // detail is never cached (staleTime + gcTime 0, always refetch on mount).
  const detailQuery = useQuery({
    queryKey: KEYS.e2eRun(orgSlug, site, runId),
    queryFn: () => fetchJson(`${base}/e2e/runs/${encodeURIComponent(runId)}`),
    enabled: open && Boolean(runId),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
  });

  const data = detailQuery.data as E2eRunDetailData | undefined;
  const verdict = data?.status ?? run?.status ?? null;
  const command = run?.summary?.command ?? null;
  const url = run?.summary?.url ?? null;
  const totalDuration = data?.report?.totalDurationMs ?? null;
  const platform = data?.report?.platform ?? null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-2xl">
        <SheetHeader className="border-b border-border">
          <div className="flex items-center gap-2">
            <VerdictBadge status={verdict} t={t} />
            <SheetTitle className="font-mono text-sm text-foreground">
              {runId}
            </SheetTitle>
          </div>
          <SheetDescription asChild>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {command && (
                <span>
                  {t("mainPanelTabs.e2eTab.command")}{" "}
                  <span className="font-medium text-foreground">{command}</span>
                </span>
              )}
              {platform && (
                <span className="font-medium text-foreground/70">
                  {platform}
                </span>
              )}
              {totalDuration != null && (
                <span className="flex items-center gap-1 tabular-nums">
                  <Clock className="size-3" />
                  {fmtMs(totalDuration)}
                </span>
              )}
              {url && (
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate font-mono text-foreground/70 hover:underline"
                >
                  {url.replace(/^https?:\/\//, "")}
                </a>
              )}
            </div>
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {isUnauthorized(detailQuery.error) ? (
            <EmptyState
              icon={<CheckCircle className="size-5" />}
              title={t("mainPanelTabs.e2eTab.notConnectedTitle")}
              description={t("mainPanelTabs.e2eTab.notConnectedDescription")}
            />
          ) : detailQuery.isLoading ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : detailQuery.error ? (
            <p className="text-sm text-muted-foreground">
              {t("mainPanelTabs.e2eTab.detailError")}
            </p>
          ) : data ? (
            <DetailBody data={data} t={t} />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
