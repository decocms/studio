/**
 * The Experiments tab: one project's experiments in its own screen, or every
 * project's in one list. A Blocks v8 project's tests are read-only here (what
 * is live); they are edited in its Experiments app.
 */

import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowUpRight } from "@untitledui/icons";
import { useQueries } from "@tanstack/react-query";
import { Card } from "@decocms/ui/components/card.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { ProjectExperimentsLive } from "@/components/experiments/experiments-live";
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

/** Each project's "Blocks v8 site" switch, in the projects' order. */
function useProjectsV8(projects: readonly SiteProject[]): boolean[] {
  const entities = useVirtualMCPsNonBlocking();
  return projects.map((p) =>
    blocksV8Project(entities.find((e) => e.id === p.id)),
  );
}

function OrgExperiments({
  projects,
  listV7,
}: {
  projects: readonly SiteProject[];
  /** The org's v7 rollout: its projects' tests are listed. */
  listV7: boolean;
}) {
  const t = useT();
  const { org, locator } = useProjectContext();
  const studio = useStudioTools();
  const navigate = useNavigate();
  // A Blocks v8 site keeps its tests in its content, edited in its own
  // Experiments app: linked below, not listed.
  const v8 = useProjectsV8(projects);
  const listed = listV7 ? projects.filter((_, i) => !v8[i]) : [];
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
      {blocks8.length > 0 && <Blocks8Experiments projects={blocks8} />}
    </div>
  );
}

/** The Blocks v8 projects, each with the way to its Experiments app. */
function Blocks8Experiments({
  projects,
}: {
  projects: readonly SiteProject[];
}) {
  const t = useT();
  const { org } = useProjectContext();
  return (
    <section
      className="flex flex-col gap-2 pt-2"
      aria-labelledby="monitor-blocks8-experiments-title"
      data-testid="monitor-blocks8-experiments"
    >
      <h2 id="monitor-blocks8-experiments-title" className="text-meta px-2">
        {t("monitor.org.blocks8ExperimentsTitle")}
      </h2>
      <Card
        size="flush"
        className="gap-0 divide-y divide-border overflow-hidden"
      >
        {projects.map((project) => (
          <div
            key={project.id}
            className="flex items-center justify-between gap-4 px-5 py-3 text-sm"
          >
            <ProjectName project={project} />
            <Link
              {...projectLink(org.slug, project.id, "experimentsApp")}
              aria-label={t("monitor.org.openExperimentsNamed", {
                project: project.title,
              })}
              className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-foreground underline-offset-2 hover:underline"
            >
              {t("monitor.org.openExperiments")}
              <ArrowUpRight size={12} />
            </Link>
          </div>
        ))}
      </Card>
    </section>
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
  // What is live, read-only: the tests are edited in the Experiments app.
  if (v8) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <ProjectExperimentsLive virtualMcpId={scopeId} />
      </div>
    );
  }
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
  if (scopeId) return <ProjectExperiments key={scopeId} scopeId={scopeId} />;
  return <OrgExperimentsView />;
}

function OrgExperimentsView() {
  const views = useControlPlaneViews();
  const projects = useSiteProjects();
  const v8 = useProjectsV8(projects);
  if (
    projects.length === 0 ||
    !experimentsTabVisible(views.experiments, v8.some(Boolean))
  ) {
    return <ExperimentsLocked scopeId={null} />;
  }
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-4 pt-6 pb-10 md:px-10">
        <OrgExperiments projects={projects} listV7={views.experiments} />
      </div>
    </div>
  );
}
