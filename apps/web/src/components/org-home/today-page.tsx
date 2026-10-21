/** The org's Overview under the new navigation: the greeting with the apps
 *  you last had open, what wants you today, and how each project is moving.
 *  Built from the board, the inbox and this browser's app history. */

import { usePreferences } from "@/hooks/use-preferences";
import { ChatInput } from "@/components/chat/input";
import {
  ChatPrefsProvider,
  DetachedChatContext,
} from "@/components/chat/context";
import { useOrgFlag } from "@/hooks/use-organization-settings";
import { Suspense } from "react";
import { Page } from "@/components/page";
import { ConnectPill } from "./connect-pill";
import { runningAgents, shippedSince, tasksNeedingMe } from "./daily-pulse";
import {
  briefDate,
  firstName,
  greetingSlot,
  pulseWindow,
  pulseWindowStart,
  type GreetingSlot,
} from "./greeting";
import { useOrgTasksSuspense } from "./use-org-tasks";
import { ForYou, Metrics, RecentApps } from "./home-overview";
import { NewProjectButton } from "@/components/projects/new-project-dialog";
import { ProjectsEmptyState } from "@/components/projects/projects-empty-state";
import { buildProjectIndex } from "@/lib/project-index";
import { useInboxFeed } from "@/hooks/use-inbox-feed";
import { useRecentApps } from "@/hooks/use-recent-apps";
import { useCapability } from "@/hooks/use-capability";
import { scopableProjects } from "@/hooks/use-project-scope";
import { authClient } from "@/lib/auth-client";
import { useProjectContext, useVirtualMCPs } from "@/sdk";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { useT } from "@/i18n/use-t.ts";
import type { TFunction, TranslationKey } from "@/i18n/use-t.ts";

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

/** What happened and what is left, in one line under the greeting. */
function briefLine(
  t: TFunction,
  shipped: number,
  slot: GreetingSlot,
  waiting: number,
  running: number,
): string {
  const overnight = pulseWindow(slot) === "overnight";
  const clauses: string[] = [];
  if (shipped > 0) {
    const changes = t(
      shipped === 1 ? "home.brief.changeOne" : "home.brief.changeMany",
      { count: shipped },
    );
    clauses.push(
      t(overnight ? "home.brief.overnightShipped" : "home.brief.todayShipped", {
        changes,
      }),
    );
  } else if (waiting === 0) {
    clauses.push(
      t(
        running > 0
          ? "home.brief.working"
          : overnight
            ? "home.brief.quietNight"
            : "home.brief.quietDay",
      ),
    );
  }
  clauses.push(
    waiting === 0
      ? t("home.brief.waitingNone")
      : t(waiting === 1 ? "home.brief.waitingOne" : "home.brief.waitingMany", {
          count: waiting,
        }),
  );
  return clauses.join(" ");
}

function OrgHomeBody({
  canManageProjects,
  eyebrow,
  greeting,
  slot,
}: {
  canManageProjects: boolean;
  eyebrow: string;
  greeting: string;
  slot: GreetingSlot;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  /** Both suspend, so this renders once with the answer to both. */
  const all = useVirtualMCPs({ pageSize: 1000 });
  const tasks = useOrgTasksSuspense();
  const inbox = useInboxFeed();
  const { recent: recentApps } = useRecentApps(org.slug);

  const projects = scopableProjects(all).filter((p) => p.id !== org.id);

  if (projects.length === 0) {
    return <ProjectsEmptyState canCreate={canManageProjects} />;
  }

  const index = buildProjectIndex(projects);
  const waiting = tasksNeedingMe(tasks, session?.user?.id);
  const brief = briefLine(
    t,
    shippedSince(tasks, pulseWindowStart(slot, new Date())),
    slot,
    waiting.length,
    runningAgents(tasks).length,
  );

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">{eyebrow}</span>
        <h1 className="text-2xl font-medium text-foreground">{greeting}</h1>
        <p className="mt-1 text-base text-pretty text-muted-foreground">
          {brief}
        </p>
      </div>
      <ForYou
        waiting={waiting}
        tasks={tasks}
        mentions={inbox.updates}
        index={index}
        orgSlug={org.slug}
      />
      <RecentApps recent={recentApps} orgSlug={org.slug} />
      <Metrics tasks={tasks} />
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
  const slot = greetingSlot(now.getHours());
  const greetingKeys = GREETING_KEYS[slot];
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
              slot={slot}
            />
          </Suspense>
        </Page.Container>
      </Page.Content>
    </Page>
  );
}
