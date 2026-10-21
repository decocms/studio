/**
 * A project's Overview under the new navigation: a task to start, its apps,
 * what in it is asking for you, then its rhythms. The board itself is
 * Execute; this is the glance.
 */

import { Suspense } from "react";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import {
  ChatPrefsProvider,
  DetachedChatContext,
} from "@/components/chat/context";
import { ChatInput } from "@/components/chat/input";
import { ConnectPill } from "@/components/org-home/connect-pill";
import { tasksNeedingMe } from "@/components/org-home/daily-pulse";
import { ForYou, Metrics } from "@/components/org-home/home-overview";
import { useOrgTasksSuspense } from "@/components/org-home/use-org-tasks";
import { Page } from "@/components/page";
import { ProjectApps } from "@/components/projects/project-apps";
import { useInboxFeed } from "@/hooks/use-inbox-feed";
import { scopableProjects } from "@/hooks/use-project-scope";
import { useT } from "@/i18n/use-t.ts";
import { authClient } from "@/lib/auth-client";
import { buildProjectIndex, projectForTask } from "@/lib/project-index";
import { useProjectContext, useVirtualMCPs } from "@/sdk";

function ProjectOverviewBody({ project }: { project: VirtualMCPEntity }) {
  const t = useT();
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const all = useVirtualMCPs({ pageSize: 1000 });
  const tasks = useOrgTasksSuspense();
  const inbox = useInboxFeed();
  const index = buildProjectIndex(scopableProjects(all));
  const projectTasks = tasks.filter(
    (task) => projectForTask(task, index)?.id === project.id,
  );
  const projectTaskIds = new Set(projectTasks.map((task) => task.id));

  return (
    <>
      <ProjectApps project={project} orgSlug={org.slug} card />
      <ForYou
        waiting={tasksNeedingMe(projectTasks, session?.user?.id)}
        tasks={projectTasks}
        mentions={inbox.updates.filter((update) =>
          projectTaskIds.has(update.taskBoardItemId),
        )}
        index={index}
        orgSlug={org.slug}
      />
      <section className="flex flex-col gap-2">
        <h2 className="flex h-8 items-center text-sm font-medium text-foreground">
          {t("projects.overview.metrics")}
        </h2>
        <Metrics tasks={projectTasks} />
      </section>
    </>
  );
}

export function ProjectOverview({ project }: { project: VirtualMCPEntity }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <Page.Actions>
        <ConnectPill />
      </Page.Actions>
      <div className="mx-auto flex w-full max-w-[1680px] flex-col gap-6 px-4 pt-4 pb-8 md:px-8">
        <Suspense fallback={null}>
          <DetachedChatContext>
            <ChatPrefsProvider>
              <ChatInput homeTaskComposer taskHint={false} />
            </ChatPrefsProvider>
          </DetachedChatContext>
        </Suspense>
        <Suspense
          fallback={
            <div className="flex h-72 items-center justify-center">
              <Spinner className="size-5 text-muted-foreground" />
            </div>
          }
        >
          <ProjectOverviewBody project={project} />
        </Suspense>
      </div>
    </div>
  );
}
