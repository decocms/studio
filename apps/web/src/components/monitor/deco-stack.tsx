/**
 * Deco Analytics sections as Monitor tabs of their own (Realtime, Pages &
 * sources, Heatmap, Errors, Events, Experiments), one under the other when a
 * tab holds several, and the bottom of Performance (Web Vitals).
 */

import { Fragment, useState } from "react";
import { BarChart10 } from "@untitledui/icons";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { Page } from "@/components/page";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import { RANGE_PILLS } from "@/layouts/main-panel-tabs/analytics-tab";
import { useProjectContext } from "@/sdk";
import { Group } from "./analytics/panels";
import { useAnalyticsSegment } from "./analytics/segment";
import { SegmentActions, SegmentChips } from "./analytics/segment-bar";
import { DecoSection, type DecoSectionId } from "./analytics/sections";
import {
  ConfigureButton,
  ConfigureDialog,
  useAnalyticsStatus,
} from "./deco-analytics";
import { type SectionRange, sectionRangeLabel } from "./audience-view";
import type { SiteProject } from "./org-insights";
import { TopbarSelect } from "./topbar-select";

function sectionTitle(section: DecoSectionId, t: TFunction): string {
  switch (section) {
    case "overview":
      return t("mainPanelTabs.analyticsTab.viewOverview");
    case "live":
      return t("monitor.view.realtime");
    case "behaviour":
      return t("mainPanelTabs.analyticsTab.viewBehaviour");
    case "events":
      return t("mainPanelTabs.analyticsTab.viewEvents");
    case "errors":
      return t("mainPanelTabs.analyticsTab.viewErrors");
    case "experiments":
      return t("mainPanelTabs.analyticsTab.viewExperiments");
    case "vitals":
      return t("mainPanelTabs.analyticsTab.viewVitals");
    case "heatmap":
      return t("mainPanelTabs.analyticsTab.viewHeatmap");
    case "quality":
      return t("mainPanelTabs.analyticsTab.viewQuality");
    case "usage":
      return t("mainPanelTabs.analyticsTab.viewUsage");
    default: {
      const unhandled: never = section;
      return unhandled;
    }
  }
}

/**
 * A site's sections one under the other, each under its name. Nothing when the
 * site isn't on Deco Analytics.
 */
export function DecoStack({
  project,
  sections,
  range,
  onConfigure,
}: {
  project: SiteProject;
  sections: readonly DecoSectionId[];
  range: SectionRange;
  /** Only the heatmap asks to open the settings. */
  onConfigure?: () => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const status = useAnalyticsStatus(org.slug, project);
  const { segment } = useAnalyticsSegment();
  if (!status.data?.registered) return null;
  return (
    <>
      {sections.map((section) => {
        const body = (
          <DecoSection
            orgSlug={org.slug}
            site={project.site}
            status={status.data}
            segment={segment}
            section={section}
            range={range}
            onConfigure={onConfigure ?? (() => undefined)}
          />
        );
        // A tab of one section is already named by the tab.
        return sections.length === 1 ? (
          <Fragment key={section}>{body}</Fragment>
        ) : (
          <Group key={section} title={sectionTitle(section, t)}>
            {body}
          </Group>
        );
      })}
    </>
  );
}

/** A Monitor tab drawn from a project's Deco Analytics sections. */
export function DecoScreen({
  project,
  sections,
}: {
  project: SiteProject | undefined;
  sections: readonly DecoSectionId[];
}) {
  const t = useT();
  const { org } = useProjectContext();
  const [range, setRange] = useState<SectionRange>("24h");
  const [configure, setConfigure] = useState(false);
  const status = useAnalyticsStatus(
    org.slug,
    { site: project?.site ?? "" },
    project !== undefined,
  );
  const { segment } = useAnalyticsSegment();
  // Realtime is always "now" and the heatmap picks its own period and filters.
  const live = sections.every((s) => s === "live");
  const heatmap = sections.includes("heatmap");
  const read = live ? "5m" : range;

  let body;
  if (!project) {
    body = (
      <EmptyState
        icon={<BarChart10 size={20} />}
        title={t("monitor.deco.pickProject")}
      />
    );
  } else if (status.isLoading) {
    body = <Skeleton className="h-64" />;
  } else if (!status.data?.registered) {
    body = (
      <EmptyState
        icon={<BarChart10 size={20} />}
        title={t("monitor.audience.empty.title")}
        description={t("monitor.audience.empty.desc")}
      />
    );
  } else {
    body = (
      <>
        {!heatmap && <SegmentChips />}
        <DecoStack
          project={project}
          sections={sections}
          range={read}
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
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-4 pt-6 pb-10 md:px-10">
        {project && status.data?.registered && (
          <Page.Actions>
            {!live && !heatmap && (
              <TopbarSelect
                label={t("monitor.audience.range")}
                value={range}
                options={RANGE_PILLS.map((r) => ({
                  value: r,
                  label: sectionRangeLabel(r, t),
                }))}
                onChange={setRange}
              />
            )}
            {!heatmap && (
              <SegmentActions
                orgSlug={org.slug}
                site={project.site}
                range={read}
                segment={segment}
              />
            )}
            <ConfigureButton onClick={() => setConfigure(true)} />
          </Page.Actions>
        )}
        {body}
      </div>
    </div>
  );
}
