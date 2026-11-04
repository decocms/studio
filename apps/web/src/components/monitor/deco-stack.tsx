/** Deco Analytics outside the Analytics tab: Web Vitals under Performance, and the Heatmap tab. */

import { useState } from "react";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { Page } from "@/components/page";
import { useProjectContext } from "@/sdk";
import { useAnalyticsSegment } from "./analytics/segment";
import { DecoSection, type DecoSectionId } from "./analytics/sections";
import {
  ConfigureButton,
  ConfigureDialog,
  useAnalyticsStatus,
} from "./deco-analytics";
import type { SectionRange } from "./audience-view";
import type { SiteProject } from "./org-insights";
import { AnalyticsEmpty, TurnOnAnalytics } from "./turn-on-analytics";
import { AnalyticsPreview, PickProject } from "./locked";

/** One of a site's sections. Nothing when the site isn't on Deco Analytics. */
export function DecoStack({
  project,
  section,
  range,
}: {
  project: SiteProject;
  section: DecoSectionId;
  range: SectionRange;
}) {
  const { org } = useProjectContext();
  const status = useAnalyticsStatus(org.slug, project);
  const { segment } = useAnalyticsSegment();
  if (!status.data?.registered) return null;
  return (
    <DecoSection
      orgSlug={org.slug}
      site={project.site}
      status={status.data}
      segment={segment}
      section={section}
      range={range}
      onConfigure={() => undefined}
    />
  );
}

/** The Heatmap tab: where visitors click and scroll on one of the project's pages. */
export function HeatmapScreen({
  project,
  projects,
  onProject,
}: {
  project: SiteProject | undefined;
  projects: readonly SiteProject[];
  onProject: (projectId: string) => void;
}) {
  const { org } = useProjectContext();
  const [configure, setConfigure] = useState(false);
  const [turnOn, setTurnOn] = useState(false);
  const status = useAnalyticsStatus(
    org.slug,
    { site: project?.site ?? "" },
    project !== undefined,
  );
  const { segment } = useAnalyticsSegment();

  let body;
  if (!project) {
    body = (
      <PickProject projects={projects} onProject={onProject}>
        <AnalyticsPreview />
      </PickProject>
    );
  } else if (status.isLoading) {
    body = <Skeleton className="h-64" />;
  } else if (!status.data?.registered) {
    const data = status.data;
    body = (
      <>
        <AnalyticsEmpty
          onTurnOn={
            data && data.configured !== false
              ? () => setTurnOn(true)
              : undefined
          }
        />
        {data && (
          <TurnOnAnalytics
            orgSlug={org.slug}
            project={project}
            status={data}
            open={turnOn}
            onOpenChange={setTurnOn}
          />
        )}
      </>
    );
  } else {
    body = (
      <>
        <DecoSection
          orgSlug={org.slug}
          site={project.site}
          status={status.data}
          segment={segment}
          section="heatmap"
          range="7d"
          onConfigure={() => setConfigure(true)}
        />
        <ConfigureDialog
          orgSlug={org.slug}
          project={project}
          status={status.data}
          open={configure}
          onOpenChange={setConfigure}
        />
      </>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      <div className="mx-auto flex h-full min-h-0 w-full max-w-[1200px] flex-col gap-4 px-4 pt-6 pb-6 md:px-10">
        {project && status.data?.registered && (
          <Page.Actions>
            <ConfigureButton onClick={() => setConfigure(true)} />
          </Page.Actions>
        )}
        {body}
      </div>
    </div>
  );
}
