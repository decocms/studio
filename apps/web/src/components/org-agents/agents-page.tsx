/**
 * Agents — every run and every schedule in the organization, in one place.
 *
 * The second of the org's two destinations. Today answers "what happened and
 * what is stopped on me"; this answers "what is the machine doing right now,
 * and what does it do without being asked". They are different questions and a
 * daily brief that tried to hold both would bury one.
 *
 * Both halves come off reads the product already makes — the board payload for
 * runs, the automation list for schedules — so this page costs no new data
 * path. What it deliberately does NOT draw is the mock's per-run progress bar
 * and step log: a run reports no percentage, and a bar filled from elapsed time
 * is a guess rendered as a measurement.
 */

import { Suspense } from "react";
import { Link } from "@tanstack/react-router";
import { Stars01, Zap } from "@untitledui/icons";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { Page } from "@/components/page";
import { AgentAvatar } from "@/components/agent-icon";
import { HomeCard, HomeCardRow } from "@/components/org-home/section";
import { useOrgTasksSuspense } from "@/components/org-home/use-org-tasks";
import {
  monthlyCost,
  runningAgents,
  runsToday,
} from "@/components/org-home/daily-pulse";
import { formatUsd } from "@/components/org-home/brief-stats";
import { useAutomations } from "@/hooks/use-automations";
import {
  DESTINATION_ROUTE,
  PROJECT_ROUTE,
} from "@/hooks/use-destination-route";
import { scopableProjects } from "@/hooks/use-project-scope";
import { buildProjectIndex, projectForTask } from "@/lib/project-index";
import { useProjectContext, useVirtualMCPs } from "@/sdk";
import { usePreferences } from "@/hooks/use-preferences";
import { useT } from "@/i18n/use-t.ts";
import type { TFunction } from "@/i18n/use-t.ts";

/** `6m`, `2h` — elapsed, not a clock time. How long a run has been going is
 *  what tells you whether to look at it; when it started is not. */
function elapsed(startedAt: string): string {
  const at = Date.parse(startedAt);
  if (Number.isNaN(at)) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** The next firing, in the reader's own locale, or a dash when nothing is
 *  scheduled — a paused automation has no next run and should not invent one. */
function nextRun(iso: string | null, locale: string): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "—";
  return new Date(at).toLocaleString(locale, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <section className="flex min-w-[168px] flex-1 flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2">
      <h3 className="truncate text-muted-foreground text-xs">{label}</h3>
      <p className="font-semibold text-base text-foreground leading-none tabular-nums">
        {value}
      </p>
    </section>
  );
}

function LiveRuns({ orgSlug, t }: { orgSlug: string; t: TFunction }) {
  const tasks = useOrgTasksSuspense();
  const all = useVirtualMCPs({ pageSize: 1000 });
  const index = buildProjectIndex(scopableProjects(all));
  const running = runningAgents(tasks);
  const byTask = new Map(tasks.map((task) => [task.id, task]));

  return (
    <HomeCard label={t("agents.live.heading")} count={running.length}>
      {running.length === 0 ? (
        <HomeCardRow>
          <p className="text-muted-foreground text-sm">
            {t("agents.live.none")}
          </p>
        </HomeCardRow>
      ) : (
        running.map((agent) => {
          const task = byTask.get(agent.taskId);
          const project = task ? projectForTask(task, index) : null;
          const cost =
            task?.threads.reduce(
              (sum, thread) => sum + (thread.costUsd ?? 0),
              0,
            ) ?? 0;
          return (
            <HomeCardRow
              key={agent.threadId}
              className="transition-colors hover:bg-accent/40"
            >
              <Link
                to={DESTINATION_ROUTE.tasks}
                params={{ org: orgSlug, taskKey: undefined }}
                className="flex min-w-0 items-center gap-3"
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Stars01 size={13} aria-hidden />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-foreground text-sm">
                    {agent.runTitle ?? agent.taskTitle}
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5 truncate text-muted-foreground text-xs">
                    {project && (
                      <AgentAvatar
                        icon={project.icon}
                        name={project.title}
                        size="2xs"
                      />
                    )}
                    {project?.title ?? t("agents.live.noProject")}
                  </span>
                </span>
                {cost > 0 && (
                  <span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
                    {formatUsd(cost)}
                  </span>
                )}
                <span className="w-8 shrink-0 text-right font-mono text-muted-foreground text-xs tabular-nums">
                  {elapsed(agent.startedAt)}
                </span>
              </Link>
            </HomeCardRow>
          );
        })
      )}
    </HomeCard>
  );
}

function Schedules({
  orgSlug,
  locale,
  t,
}: {
  orgSlug: string;
  locale: string;
  t: TFunction;
}) {
  /** Non-blocking: the runs above are the reason to open this page, and they
   *  should not wait on a list that answers a different question. */
  const automations = useAutomations().data;
  if (!automations) return null;

  return (
    <HomeCard label={t("agents.schedules.heading")} count={automations.length}>
      {automations.length === 0 ? (
        <HomeCardRow>
          <p className="text-muted-foreground text-sm">
            {t("agents.schedules.none")}
          </p>
        </HomeCardRow>
      ) : (
        automations.map((automation) => (
          <HomeCardRow
            key={automation.id}
            className="transition-colors hover:bg-accent/40"
          >
            <Link
              to={PROJECT_ROUTE.automation}
              params={{
                org: orgSlug,
                agentId: automation.virtual_mcp_id,
                automationId: automation.id,
              }}
              className="flex min-w-0 items-center gap-3"
            >
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <Zap size={13} aria-hidden />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-foreground text-sm">
                  {automation.name}
                </span>
                <span className="truncate text-muted-foreground text-xs">
                  {t("agents.schedules.triggers", {
                    count: automation.trigger_count,
                  })}
                </span>
              </span>
              <span className="shrink-0 font-mono text-muted-foreground text-xs">
                {automation.active
                  ? nextRun(automation.nearest_next_run_at, locale)
                  : t("agents.schedules.paused")}
              </span>
            </Link>
          </HomeCardRow>
        ))
      )}
    </HomeCard>
  );
}

function AgentsBody({ orgSlug, locale }: { orgSlug: string; locale: string }) {
  const t = useT();
  const tasks = useOrgTasksSuspense();
  const all = useVirtualMCPs({ pageSize: 1000 });
  const index = buildProjectIndex(scopableProjects(all));
  const runs = runsToday(tasks);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap gap-2">
        <Tile label={t("agents.tiles.running")} value={String(runs.live)} />
        <Tile label={t("agents.tiles.runsToday")} value={String(runs.runs)} />
        <Tile
          label={t("agents.tiles.cost")}
          value={formatUsd(monthlyCost(index, tasks).total)}
        />
      </div>
      <LiveRuns orgSlug={orgSlug} t={t} />
      <Schedules orgSlug={orgSlug} locale={locale} t={t} />
    </div>
  );
}

export function AgentsPage() {
  const t = useT();
  const { org } = useProjectContext();
  const [preferences] = usePreferences();

  return (
    <Page>
      {/* The route is Home's, so the panel's own title says "Home" until this
          overrides it — `?view=` is what makes them two destinations. */}
      <Page.Title>{t("agents.title")}</Page.Title>
      <Page.Content>
        <Page.Container width="wide" className="flex flex-col gap-6">
          <div className="flex flex-col gap-1">
            <h1 className="font-semibold text-foreground text-xl tracking-tight">
              {t("agents.title")}
            </h1>
            <p className="text-muted-foreground text-sm">
              {t("agents.subtitle")}
            </p>
          </div>
          <Suspense
            fallback={
              <div className="flex min-h-64 items-center justify-center">
                <Spinner className="size-5 text-muted-foreground" />
              </div>
            }
          >
            <AgentsBody orgSlug={org.slug} locale={preferences.language} />
          </Suspense>
        </Page.Container>
      </Page.Content>
    </Page>
  );
}
