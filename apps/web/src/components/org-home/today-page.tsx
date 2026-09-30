/** Today — the org's daily brief; `AgentsPage` is its other destination.
 *
 *  It answers what ran, what broke and what is stopped on you before it lists
 *  projects. Everything below the headline derives from the ONE board query it
 *  already makes, plus the automation list for the schedules card. */

import { usePreferences } from "@/hooks/use-preferences";
import { ChatInput } from "@/components/chat/input";
import {
  ChatPrefsProvider,
  DetachedChatContext,
} from "@/components/chat/context";
import { useOrgFlag } from "@/hooks/use-organization-settings";
import { Suspense } from "react";
import { Page } from "@/components/page";
import { ReportBanner } from "@/components/home/report-banner";
import { ConnectPill } from "./connect-pill";
import {
  costSeriesForProjectMonthToDate,
  costSeriesMonthToDate,
  dailyPulse,
  monthlyCost,
  projectSummaries,
  RHYTHM_DAYS,
  runningAgents,
  runsSeries,
  runsToday,
  shippedSeries,
  tasksNeedingMe,
} from "./daily-pulse";
import { BriefStats } from "./brief-stats";
import { firstName, greetingSlot } from "./greeting";
import { AgentsRunning } from "./agents-running";
import { BriefHeadline, briefDate } from "./brief-headline";
import { NeedsYou } from "./needs-you";
import { useOrgTasksSuspense } from "./use-org-tasks";
import { ProjectRoster } from "./project-roster";
import { HomeSplit } from "./section";
import { WhatMoved } from "./what-moved";
import { OrgApps } from "@/components/projects/project-apps";
import { NewProjectButton } from "@/components/projects/new-project-dialog";
import { ProjectsEmptyState } from "@/components/projects/projects-empty-state";
import { TrainingCard } from "./training-card";
import { buildProjectIndex } from "@/lib/project-index";
import { useAutomations } from "@/hooks/use-automations";
import { useCapability } from "@/hooks/use-capability";
import { scopableProjects } from "@/hooks/use-project-scope";
import { authClient } from "@/lib/auth-client";
import { useProjectContext, useVirtualMCPs } from "@/sdk";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";

const GREETING_KEYS = {
  morning: {
    named: "home.orgHome.greetingMorning",
    bare: "home.orgHome.greetingMorningBare",
  },
  afternoon: {
    named: "home.orgHome.greetingAfternoon",
    bare: "home.orgHome.greetingAfternoonBare",
  },
  evening: {
    named: "home.orgHome.greetingEvening",
    bare: "home.orgHome.greetingEveningBare",
  },
} as const satisfies Record<
  string,
  { named: TranslationKey; bare: TranslationKey }
>;

/** Holds the height while both reads settle. Not a row skeleton: their number
 *  is what we are waiting to learn. */
function OrgHomeBodyFallback() {
  return (
    <div className="flex min-h-64 items-center justify-center">
      <Spinner className="size-5 text-muted-foreground" />
    </div>
  );
}

function OrgHomeBody({
  canManageProjects,
  eyebrow,
  greeting,
}: {
  canManageProjects: boolean;
  eyebrow: string;
  greeting: string;
}) {
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  /** Both suspend, so this renders once with the answer to both. Page size is
   *  raised off the default because the roster's "see all" gate counts. */
  const all = useVirtualMCPs({ pageSize: 1000 });
  const tasks = useOrgTasksSuspense();
  /** Non-blocking, read above the empty-state return so hook order matches on
   *  both branches. Says nothing until it lands rather than claiming zero. */
  const automations = useAutomations().data;

  const projects = scopableProjects(all).filter((p) => p.id !== org.id);

  if (projects.length === 0) {
    return <ProjectsEmptyState canCreate={canManageProjects} />;
  }

  const index = buildProjectIndex(projects);
  const waiting = tasksNeedingMe(tasks, session?.user?.id);
  const pulse = dailyPulse(tasks);
  const series = new Map(
    projects.map((project) => [
      project.id,
      shippedSeries(index, tasks, project.id, RHYTHM_DAYS),
    ]),
  );
  const cost = monthlyCost(index, tasks);
  /** Capped at the design system's `--chart-1..5` ramp. Month-to-date, the
   *  same window as `cost`, so headline and chart are one claim. */
  const costSeriesByProject = new Map(
    cost.byProject
      .slice(0, 5)
      .map(({ projectId }) => [
        projectId,
        costSeriesForProjectMonthToDate(index, tasks, projectId),
      ]),
  );

  return (
    <div className="flex flex-col gap-10">
      <BriefHeadline
        eyebrow={eyebrow}
        greeting={greeting}
        pulse={pulse}
        waiting={waiting.length}
      />
      <BriefStats
        cost={cost}
        costRhythm={costSeriesMonthToDate(tasks)}
        costSeriesByProject={costSeriesByProject}
        runs={runsToday(tasks)}
        runsRhythm={runsSeries(tasks, RHYTHM_DAYS)}
        automations={
          automations
            ? {
                running: automations.filter((a) => a.active).length,
                paused: automations.filter((a) => !a.active).length,
              }
            : null
        }
        projectsById={new Map(projects.map((p) => [p.id, p]))}
        orgSlug={org.slug}
      />
      <OrgApps projects={projects} orgSlug={org.slug} />
      {/* The work on the left, the standing readouts on the right: what needs
          answering and what changed are read as sentences; what each project is
          moving and what is running are read as numbers. */}
      <HomeSplit
        main={
          <>
            <NeedsYou tasks={waiting} index={index} orgSlug={org.slug} />
            <WhatMoved
              projects={projects}
              index={index}
              tasks={tasks}
              orgSlug={org.slug}
            />
          </>
        }
        aside={
          <>
            <ProjectRoster
              projects={projects}
              summaries={projectSummaries(index, tasks, session?.user?.id)}
              series={series}
            />
            <AgentsRunning agents={runningAgents(tasks)} orgSlug={org.slug} />
          </>
        }
      />

      {/* Standing OFFERS, which is why they are last — and why they are inside
          this branch. The connect pill is never satisfied by anything the page
          can see, so above the brief it becomes permanent furniture; on an org
          with no projects yet it competes with the one invitation that matters.
          Full width, not the aside: a narrow column stranded the report card
          off to one side whenever the board had nothing on it. */}
      <footer className="flex flex-col gap-4 pt-3">
        <TrainingCard />
        {/* The store's own diagnostic. Self-hiding and failure-proof, so it
            costs nothing for the orgs without one. */}
        <ReportBanner />
      </footer>
    </div>
  );
}

export function TodayPage() {
  const t = useT();
  const [preferences] = usePreferences();
  const taskIntakeEnabled = useOrgFlag("home_task_intake_enabled");
  const { data: session } = authClient.useSession();

  const { granted: canManageProjects } = useCapability("agents:manage");

  /** Read at render rather than on a timer; it does not tick over midnight. */
  const now = new Date();
  const name = firstName(session?.user?.name);
  const greetingKeys = GREETING_KEYS[greetingSlot(now.getHours())];
  /** The date is the eyebrow; the greeting opens the sentence under it.
   *  Computed at render rather than on a timer. */
  const eyebrow = briefDate(preferences.language, now);
  const greetingLine = name
    ? t(greetingKeys.named, { name })
    : t(greetingKeys.bare);

  return (
    <Page>
      <Page.Actions secondary={<ConnectPill />}>
        {canManageProjects && <NewProjectButton source="org_home_header" />}
      </Page.Actions>
      <Page.Content>
        <Page.Container
          width="wide"
          /** `min-h-full` gives the empty state a height to centre in. */
          className="flex min-h-full flex-col gap-10"
        >
          {taskIntakeEnabled && (
            <Suspense fallback={null}>
              <DetachedChatContext>
                <ChatPrefsProvider>
                  <ChatInput homeTaskComposer />
                </ChatPrefsProvider>
              </DetachedChatContext>
            </Suspense>
          )}

          {/* ONE boundary over both reads. The dashboard decides its layout
              from them together, so resolving them separately meant rendering
              "no activity" first and re-laying-out when it arrived, which is a
              shift on every visit to a board that has anything on it. */}
          <Suspense fallback={<OrgHomeBodyFallback />}>
            <OrgHomeBody
              canManageProjects={canManageProjects}
              eyebrow={eyebrow}
              greeting={greetingLine}
            />
          </Suspense>
        </Page.Container>
      </Page.Content>
    </Page>
  );
}
