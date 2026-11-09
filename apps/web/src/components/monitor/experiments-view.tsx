/** The Experiments tab: one project's experiments in its own screen, or every project's in one list. */

import { useNavigate } from "@tanstack/react-router";
import { useQueries } from "@tanstack/react-query";
import { Card } from "@decocms/ui/components/card.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { ProjectIcon } from "@/components/project-icon";
import { useControlPlaneViews } from "@/hooks/use-organization-settings";
import { type Experiment, experimentsQuery } from "@/hooks/use-experiments";
import {
  blocksV8Project,
  useBlocksV8Project,
} from "@/hooks/use-blocks-v8-project";
import { useT } from "@/i18n/use-t.ts";
import {
  ExperimentRow,
  ExperimentsTab,
} from "@/layouts/main-panel-tabs/experiments-tab";
import { experimentsTabVisible } from "@/layouts/main-panel-tabs/experiments-tab-choice";
import { useStudioTools } from "@/lib/studio-tools";
import { useProjectContext, useVirtualMCPsNonBlocking } from "@/sdk";
import { Locked } from "./locked";
import { useSiteProjects } from "./monitor-views";
import type { SiteProject } from "./org-insights";
import { connectLink, projectLink } from "./parts";

/** The faded list behind the connect card. */
function ListPreview() {
  return (
    <div className="surface flex flex-col divide-y divide-border">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-2 px-5 py-4">
          <div className="h-4 w-1/3 rounded bg-muted" />
          <div className="h-3 w-1/2 rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

function ProjectName({ project }: { project: SiteProject }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <ProjectIcon icon={project.icon} name={project.title} />
      <span className="truncate">{project.title}</span>
    </span>
  );
}

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

function OrgExperiments({ projects }: { projects: readonly SiteProject[] }) {
  const t = useT();
  const { org, locator } = useProjectContext();
  const studio = useStudioTools();
  const navigate = useNavigate();
  const entities = useVirtualMCPsNonBlocking();
  // A Blocks v8 site keeps its experiments in its draft, read in the project's own tab.
  const v8 = projects.map((p) =>
    blocksV8Project(entities.find((e) => e.id === p.id)),
  );
  const listed = projects.filter((_, i) => !v8[i]);
  const blocks8 = projects.filter((_, i) => v8[i]);
  const results = useQueries({
    queries: listed.map((p) => ({
      ...experimentsQuery(locator, studio, p.site),
      retry: false,
    })),
  });
  const loading = results.some((r) => r.isLoading);
  const failed = listed.filter((_, i) => results[i]?.isError);
  const rows = listed
    .flatMap((project, i) =>
      (results[i]?.data ?? []).map((experiment) => ({ project, experiment })),
    )
    .sort(byRunningThenRecent);

  if (
    !loading &&
    rows.length === 0 &&
    failed.length === 0 &&
    blocks8.length === 0
  ) {
    const first = projectLink(org.slug, projects[0]?.id ?? "", "experiments");
    return (
      <Locked
        kind="metrics"
        title={t("monitor.locked.firstExperiment.title")}
        steps={[
          {
            source: "site",
            state: "off",
            meta: t("monitor.powers.siteExperiments"),
            label: t("monitor.connect.firstExperiment"),
            link: first,
          },
        ]}
        link={first}
      >
        <ListPreview />
      </Locked>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {(loading || rows.length > 0) && (
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
      )}
      {failed.length > 0 && (
        <p className="text-meta px-2 pb-1">
          {t("monitor.org.unreadable", {
            names: failed.map((p) => p.title).join(", "),
          })}
        </p>
      )}
      {blocks8.length > 0 && (
        <p className="text-meta px-2 pb-1">
          {t("monitor.org.blocks8Experiments", {
            names: blocks8.map((p) => p.title).join(", "),
          })}
        </p>
      )}
    </div>
  );
}

function ExperimentsLocked({ scopeId }: { scopeId: string | null }) {
  const t = useT();
  const { org } = useProjectContext();
  return (
    <div className="px-4 pt-6 pb-10 md:px-10">
      <Locked
        kind="metrics"
        title={t("monitor.locked.experiments.title")}
        steps={[
          {
            source: "site",
            state: "off",
            meta: t("monitor.powers.siteExperiments"),
          },
        ]}
        link={connectLink(org.slug, scopeId)}
      >
        <ListPreview />
      </Locked>
    </div>
  );
}

/** One project's tests: the org's rollout, or any Blocks v8 project, whose
 *  tests are content its editors already own. */
function ProjectExperiments({ scopeId }: { scopeId: string }) {
  const views = useControlPlaneViews();
  const v8 = useBlocksV8Project(scopeId);
  if (!experimentsTabVisible(views.experiments, v8)) {
    return <ExperimentsLocked scopeId={scopeId} />;
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ExperimentsTab virtualMcpId={scopeId} />
    </div>
  );
}

export function ExperimentsView({ scopeId }: { scopeId: string | null }) {
  const views = useControlPlaneViews();
  const projects = useSiteProjects();
  if (scopeId) return <ProjectExperiments key={scopeId} scopeId={scopeId} />;
  if (!views.experiments || projects.length === 0) {
    return <ExperimentsLocked scopeId={null} />;
  }
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-4 pt-6 pb-10 md:px-10">
        <OrgExperiments projects={projects} />
      </div>
    </div>
  );
}
