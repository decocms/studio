/**
 * Overview tab — a project's home.
 *
 * A composer then the feed, in the org home's column. */
import { Suspense } from "react";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { CommerceReportBanner } from "@/components/home/commerce-report-banner";
import { NewTaskComposer } from "@/components/org-home/new-task-composer";
import {
  ProjectFeed,
  useOrgTasksSuspense,
} from "@/components/org-home/project-feed";
import { Main } from "@/components/main";
import { useProjectScope } from "@/hooks/use-project-scope";
import { useT } from "@/i18n/use-t";

/**
 * The org home's feed, narrowed to the project in scope.
 *
 * Suspends on the board, so it is wrapped where it renders — the composer above
 * it is ready immediately and must not be held back by a list.
 */
function ProjectFeedForProject() {
  const { project } = useProjectScope();
  const tasks = useOrgTasksSuspense();
  if (!project) return null;
  return <ProjectFeed projects={[project]} tasks={tasks} showFilter={false} />;
}

export function OverviewTab() {
  const t = useT();

  return (
    <Main.Container width="reading" className="flex flex-col gap-8">
      <CommerceReportBanner />
      <NewTaskComposer />
      <Suspense
        fallback={
          <div className="flex min-h-48 items-center justify-center">
            <Spinner
              className="size-5 text-muted-foreground"
              label={t("common.loading")}
            />
          </div>
        }
      >
        <ProjectFeedForProject />
      </Suspense>
    </Main.Container>
  );
}
