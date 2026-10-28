/**
 * Experiments across the org: every site project read at once
 * and laid side by side, each line opening that project's own screen. Inside
 * a project the Monitor shows the project's screens as they are; this is only
 * the org's view of them.
 */

import { useNavigate } from "@tanstack/react-router";
import { useQueries } from "@tanstack/react-query";
import { Card } from "@decocms/ui/components/card.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { ProjectIcon } from "@/components/project-icon";
import { type Experiment, experimentsQuery } from "@/hooks/use-experiments";
import { useT } from "@/i18n/use-t.ts";
import { useStudioTools } from "@/lib/studio-tools";
import { ExperimentRow } from "@/layouts/main-panel-tabs/experiments-tab";
import { useProjectContext } from "@/sdk";
import { projectLink } from "./parts";
import { ExperimentsPreview, Locked } from "./locked";
import { monitorPreview } from "./preview";

/** A project with a site, as the org views read it. */
export interface SiteProject {
  id: string;
  title: string;
  icon: string | null | undefined;
  /** The site its experiments live under. */
  site: string;
  /** The site its traffic is reported under, which a migration may override. */
  analyticsSite: string;
}

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
  const navigate = useNavigate();
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

  return (
    <div className="flex flex-col gap-2">
      <Card
        size="flush"
        className="gap-0 divide-y divide-border overflow-hidden"
      >
        {loading && rows.length === 0 && (
          <div className="flex flex-col gap-3 px-5 py-4">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-1/3" />
          </div>
        )}
        {rows.map(({ project, experiment }) => (
          <ExperimentRow
            key={`${project.id}:${experiment.id}`}
            experiment={experiment}
            onOpen={() =>
              navigate(projectLink(org.slug, project.id, "experiments"))
            }
            project={<ProjectName project={project} />}
          />
        ))}
      </Card>
      <Unreadable projects={failed} />
    </div>
  );
}
