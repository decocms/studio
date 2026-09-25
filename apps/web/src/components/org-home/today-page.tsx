/** Today — the org's daily brief, and the org's other destination is `AgentsPage`.
 *
 *  A storefront team opens this to learn what the agents did overnight, whether
 *  anything broke, and what is stopped waiting on them, so the page answers
 *  those three before it lists projects, which are navigation. Everything below
 *  the headline derives from the ONE board query it already makes, plus the
 *  automation list for the schedules card; the report banner hides itself when
 *  it has nothing. */

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

/** Holds the dashboard's height while both reads settle. Deliberately not a
 *  skeleton of the rows: their number is the thing we are waiting to learn. */
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
  /** Both SUSPEND, so this renders once with the answer to both. The page size
   *  is raised off the collection default (100) because the roster's "see all"
   *  gate counts projects: a truncated read would hide the link. */
  const all = useVirtualMCPs({ pageSize: 1000 });
  const tasks = useOrgTasksSuspense();
  /** Non-blocking, and read above the empty-state return so the hook order is
   *  the same on both branches. The card says nothing until it lands rather
   *  than claiming a zero, which reads as "you have none". */
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
  /** One line per top spender in the cost drill-down — same limit as the
   *  design system's fixed `--chart-1..5` categorical ramp. Month-to-date, same
   *  window as `cost` itself: the card's headline and its chart are one claim,
   *  not two windows wearing one label. */
  const costSeriesByProject = new Map(
    cost.byProject
      .slice(0, 5)
      .map(({ projectId }) => [
        projectId,
        costSeriesForProjectMonthToDate(index, tasks, projectId),
      ]),
  );

  return (
    <div className="flex flex-col gap-8">
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
              action={
                canManageProjects && (
                  <NewProjectButton source="org_home" variant="ghost" />
                )
              }
            />
            <AgentsRunning agents={runningAgents(tasks)} orgSlug={org.slug} />
            {/* The store's own diagnostic. Self-hiding and failure-proof, so it
                costs nothing for the orgs without one. */}
            <ReportBanner />
          </>
        }
      />

      {/* Standing OFFERS, which is why they are last — and why they are inside
          this branch. The connect pill is never satisfied by anything the page
          can see, so above the brief it becomes permanent furniture; on an org
          with no projects yet it competes with the one invitation that matters.
          Each sits at the natural width of its own content. */}
      <footer className="flex flex-col gap-4 pt-3">
        <TrainingCard />
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

  /** Read at render, so it is right on every navigation to the home and never
   *  needs a timer. It does not tick over midnight; nobody watches it. */
  const now = new Date();
  const name = firstName(session?.user?.name);
  const greetingKeys = GREETING_KEYS[greetingSlot(now.getHours())];
  /** The date is the eyebrow; the greeting opens the sentence under it, the
   *  way a brief reads. Computed at render, so it is right on every
   *  navigation and never needs a timer. Just the date, no "Daily brief · Org"
   *  trailer, which was noise nobody was reading. */
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
          /** `min-h-full` so the empty state has a height to centre itself in;
           *  a populated home simply overflows it as usual. */
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
