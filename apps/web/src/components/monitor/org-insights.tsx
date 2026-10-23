/**
 * Experiments and Analytics across the org: every site project read at once
 * and laid side by side, each line opening that project's own screen. Inside
 * a project the Monitor shows the project's screens as they are; this is only
 * the org's view of them.
 */

import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueries } from "@tanstack/react-query";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { Panel } from "@/components/panel";
import { ProjectIcon } from "@/components/project-icon";
import {
  type Experiment,
  type ExperimentStatus,
  experimentsQuery,
} from "@/hooks/use-experiments";
import { useT } from "@/i18n/use-t.ts";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import {
  fetchJson,
  fmtMetric,
  RANGE_PILLS,
} from "@/layouts/main-panel-tabs/analytics-tab";
import {
  STATUS_DOT,
  useLifecycleLabel,
  useStatusLabel,
} from "@/layouts/main-panel-tabs/experiments-tab";
import { MetricCard } from "@/layouts/task-board/analytics-sections";
import { useProjectContext } from "@/sdk";
import { projectLink } from "./parts";
import { ExperimentsPreview, Locked } from "./locked";
import { monitorPreview } from "./preview";

/** A project with a site, as the org views read it. */
export interface SiteProject {
  id: string;
  title: string;
  icon: string | null | undefined;
  site: string;
}

const LINE =
  "group flex h-10 w-full items-center gap-3 rounded-lg px-2 text-left transition-colors hover:bg-accent/50";

const CARD = "surface flex flex-col gap-2 p-3";

/** Lines shown before "show more", so a busy org still reads at a glance. */
const VISIBLE = 8;

function ProjectName({ project }: { project: SiteProject }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <ProjectIcon icon={project.icon} name={project.title} />
      <span className="truncate">{project.title}</span>
    </span>
  );
}

/** The org's names for projects it couldn't read, said once and quietly. */
function Unreadable({ projects }: { projects: readonly SiteProject[] }) {
  const t = useT();
  if (projects.length === 0) return null;
  return (
    <p className="px-2 pb-1 text-meta">
      {t("monitor.org.unreadable", {
        names: projects.map((p) => p.title).join(", "),
      })}
    </p>
  );
}

// --- experiments -------------------------------------------------------------

/** Summary order: what is live first, then what waits, then what is done. */
const STATUS_ORDER: readonly ExperimentStatus[] = [
  "running",
  "paused",
  "draft",
  "ended",
];

/** Running first, then whatever moved last. */
function byRunningThenRecent(
  a: { experiment: Experiment },
  b: { experiment: Experiment },
): number {
  const running =
    Number(b.experiment.status === "running") -
    Number(a.experiment.status === "running");
  return (
    running ||
    Date.parse(b.experiment.updatedAt) - Date.parse(a.experiment.updatedAt)
  );
}

export function OrgExperiments({
  projects,
}: {
  projects: readonly SiteProject[];
}) {
  const t = useT();
  const { org, locator } = useProjectContext();
  const studio = useStudioTools();
  const statusLabel = useStatusLabel();
  const lifecycle = useLifecycleLabel();
  const [open, setOpen] = useState(false);
  const results = useQueries({
    queries: projects.map((p) => ({
      ...experimentsQuery(locator, studio, p.site),
      retry: false,
    })),
  });

  const loading = results.some((r) => r.isLoading);
  const failed = projects.filter((_, i) => results[i]?.isError);
  const rows = projects
    .flatMap((project, i) =>
      (results[i]?.data ?? []).map((experiment) => ({ project, experiment })),
    )
    .sort(byRunningThenRecent);

  if (!loading && rows.length === 0 && failed.length === 0) {
    return (
      <Locked
        kind="experiments"
        title={t("monitor.locked.firstExperiment.title")}
        steps={[
          {
            source: "site",
            state: "off",
            meta: t("monitor.powers.siteExperiments"),
            label: t("monitor.connect.firstExperiment"),
            link: projectLink(org.slug, projects[0]?.id ?? "", "experiments"),
          },
        ]}
        link={projectLink(org.slug, projects[0]?.id ?? "", "experiments")}
      >
        <ExperimentsPreview experiments={monitorPreview(null).experiments} />
      </Locked>
    );
  }

  const shown = open ? rows : rows.slice(0, VISIBLE);
  const hidden = rows.length - shown.length;
  return (
    <section className={CARD}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-2 pt-1 pb-1">
        <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
          {t("monitor.view.experiments")}
          <span className="text-muted-foreground tabular-nums">
            {rows.length}
          </span>
        </h2>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta">
          {STATUS_ORDER.map((status) => {
            const count = rows.filter(
              (r) => r.experiment.status === status,
            ).length;
            return (
              count > 0 && (
                <span key={status} className="flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className={cn("size-1.5 rounded-full", STATUS_DOT[status])}
                  />
                  {statusLabel(status)}
                  <span className="tnum">{count}</span>
                </span>
              )
            );
          })}
        </span>
      </div>
      <div className="flex flex-col">
        {loading && rows.length === 0 && (
          <>
            <Skeleton className="mx-2 my-3 h-4" />
            <Skeleton className="mx-2 my-3 h-4" />
          </>
        )}
        {shown.map(({ project, experiment }) => (
          <Link
            key={experiment.id}
            {...projectLink(org.slug, project.id, "experiments")}
            className={LINE}
          >
            <span
              role="img"
              aria-label={statusLabel(experiment.status)}
              className="flex size-4 shrink-0 items-center justify-center"
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  STATUS_DOT[experiment.status],
                )}
              />
            </span>
            <span className="min-w-0 shrink-0 truncate text-sm text-foreground">
              {experiment.name}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
              {statusLabel(experiment.status)} · {lifecycle(experiment)}
            </span>
            <span className="hidden max-w-56 shrink-0 text-xs text-muted-foreground md:flex">
              <ProjectName project={project} />
            </span>
          </Link>
        ))}
        {hidden > 0 || open ? (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className={cn(LINE, "text-sm text-muted-foreground")}
          >
            <span className="size-4 shrink-0" />
            {open
              ? t("monitor.signals.less")
              : t("monitor.signals.more", { count: hidden })}
          </button>
        ) : null}
      </div>
      <Unreadable projects={failed} />
    </section>
  );
}

// --- analytics ---------------------------------------------------------------

/** The overview's headline row, as `/analytics/data?view=overview` returns it. */
interface Kpis {
  visitors: number;
  pageviews: number;
  sessions: number;
  bounce_pct: number | null;
  duration_s: number | null;
}

/** Visitors, pageviews and sessions add up across sites; rates do not. */
const ADDITIVE = ["visitors", "pageviews", "sessions"] as const;

type SiteTraffic =
  | { state: "loading" }
  | { state: "off" }
  | { state: "ok"; kpis: Kpis };

const num = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** A failed read, an unregistered site or no payload all mean "not connected". */
function trafficOf(result: {
  isLoading: boolean;
  isError: boolean;
  data: unknown;
}): SiteTraffic {
  if (result.isLoading) return { state: "loading" };
  if (result.isError) return { state: "off" };
  const response = (result.data ?? {}) as {
    registered?: boolean;
    data?: { kpis?: unknown };
  };
  if (response.registered === false || !response.data) return { state: "off" };
  const row = (
    Array.isArray(response.data.kpis) ? (response.data.kpis[0] ?? {}) : {}
  ) as Record<string, unknown>;
  return {
    state: "ok",
    kpis: {
      visitors: num(row.visitors) ?? 0,
      pageviews: num(row.pageviews) ?? 0,
      sessions: num(row.sessions) ?? 0,
      bounce_pct: num(row.bounce_pct),
      duration_s: num(row.duration_s),
    },
  };
}

const COLS =
  "grid grid-cols-[minmax(0,1fr)_repeat(3,5.5rem)] md:grid-cols-[minmax(0,1fr)_repeat(5,6rem)] items-center gap-3";

/** Sites read but answering nothing sink below the ones with traffic. */
const RANK: Record<SiteTraffic["state"], number> = {
  ok: 0,
  loading: 1,
  off: 2,
};

export function OrgAnalytics({
  projects,
}: {
  projects: readonly SiteProject[];
}) {
  const t = useT();
  const { org } = useProjectContext();
  const [range, setRange] = useState<string>("24h");
  const results = useQueries({
    queries: projects.map((p) => ({
      // The project's own Overview reads this same key, so they share a cache.
      queryKey: KEYS.analyticsData(org.slug, p.site, "overview", range),
      queryFn: () =>
        fetchJson(
          `/api/${org.slug}/hosting/${encodeURIComponent(
            p.site,
          )}/analytics/data?view=overview&range=${encodeURIComponent(range)}`,
        ),
      retry: false,
      staleTime: 30_000,
    })),
  });

  const rows = projects
    .map((project, i) => ({
      project,
      traffic: trafficOf(
        results[i] ?? { isLoading: true, isError: false, data: undefined },
      ),
    }))
    .sort(
      (a, b) =>
        RANK[a.traffic.state] - RANK[b.traffic.state] ||
        (b.traffic.state === "ok" ? b.traffic.kpis.visitors : 0) -
          (a.traffic.state === "ok" ? a.traffic.kpis.visitors : 0),
    );
  const connected = rows.flatMap((r) =>
    r.traffic.state === "ok" ? [r.traffic.kpis] : [],
  );

  const picker = (
    <Select value={range} onValueChange={setRange}>
      <SelectTrigger
        size="sm"
        className="w-[96px]"
        aria-label={t("monitor.orgAnalytics.range")}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {RANGE_PILLS.map((r) => (
          <SelectItem key={r} value={r}>
            {r}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  const metricName = (key: (typeof ADDITIVE)[number]) => {
    switch (key) {
      case "visitors":
        return t("monitor.orgAnalytics.visitors");
      case "pageviews":
        return t("monitor.orgAnalytics.pageviews");
      case "sessions":
        return t("monitor.orgAnalytics.sessions");
      default: {
        const unhandled: never = key;
        return unhandled;
      }
    }
  };

  return (
    <>
      <Panel.Toolbar.Right.Portal fallback={picker}>
        {picker}
      </Panel.Toolbar.Right.Portal>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {ADDITIVE.map((key) => (
            <MetricCard
              key={key}
              title={metricName(key)}
              value={
                connected.length === 0
                  ? "–"
                  : fmtMetric(
                      key,
                      connected.reduce((sum, k) => sum + k[key], 0),
                    )
              }
              caption={
                <span className="text-meta">
                  {t("monitor.orgAnalytics.across", {
                    count: connected.length,
                    total: projects.length,
                  })}
                </span>
              }
            />
          ))}
        </div>
        <section className={CARD}>
          <div className={cn(COLS, "px-2 pt-1 pb-1 text-meta")}>
            <span>{t("monitor.filter.project")}</span>
            <span className="text-right">
              {t("monitor.orgAnalytics.visitors")}
            </span>
            <span className="text-right">
              {t("monitor.orgAnalytics.pageviews")}
            </span>
            <span className="text-right">
              {t("monitor.orgAnalytics.sessions")}
            </span>
            <span className="hidden text-right md:block">
              {t("monitor.orgAnalytics.bounce")}
            </span>
            <span className="hidden text-right md:block">
              {t("monitor.orgAnalytics.duration")}
            </span>
          </div>
          <div className="flex flex-col">
            {rows.map(({ project, traffic }) => (
              <Link
                key={project.id}
                {...projectLink(org.slug, project.id, "analytics")}
                className={cn(
                  COLS,
                  "h-10 rounded-lg px-2 text-sm transition-colors hover:bg-accent/50",
                )}
              >
                <span
                  className={cn(
                    "min-w-0",
                    traffic.state === "ok"
                      ? "text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  <ProjectName project={project} />
                </span>
                <TrafficCells traffic={traffic} />
              </Link>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

function TrafficCells({ traffic }: { traffic: SiteTraffic }) {
  const t = useT();
  switch (traffic.state) {
    case "loading":
      return <Skeleton className="col-span-3 h-4 md:col-span-5" />;
    case "off":
      return (
        <span className="col-span-3 text-right text-meta md:col-span-5">
          {t("monitor.orgAnalytics.notConnected")}
        </span>
      );
    case "ok": {
      const { kpis } = traffic;
      return (
        <>
          <span className="tnum text-right text-foreground">
            {fmtMetric("visitors", kpis.visitors)}
          </span>
          <span className="tnum text-right text-muted-foreground">
            {fmtMetric("pageviews", kpis.pageviews)}
          </span>
          <span className="tnum text-right text-muted-foreground">
            {fmtMetric("sessions", kpis.sessions)}
          </span>
          <span className="tnum hidden text-right text-muted-foreground md:block">
            {fmtMetric("bounce_pct", kpis.bounce_pct)}
          </span>
          <span className="tnum hidden text-right text-muted-foreground md:block">
            {fmtMetric("duration_s", kpis.duration_s)}
          </span>
        </>
      );
    }
    default: {
      const unhandled: never = traffic;
      return unhandled;
    }
  }
}
