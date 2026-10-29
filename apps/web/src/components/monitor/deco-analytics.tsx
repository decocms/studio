/** Which Deco Analytics sections a site has (drawn in `./analytics`), and its registration and settings. */

import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings01 } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Tabs, TabsList, TabsTrigger } from "@decocms/ui/components/tabs.tsx";
import { useT } from "@/i18n/use-t.ts";
import {
  type AnalyticsRegisterResult,
  type AnalyticsStatus,
  ConfigurationPanel,
  DATA_VIEWS,
  fetchJson,
  RegisterCard,
} from "@/layouts/main-panel-tabs/analytics-tab";
import { KEYS } from "@/lib/query-keys";
import type { SiteProject } from "./org-insights";

/**
 * Overview first, as the tab opens on it. Heatmap is listed even without its
 * module, where it explains how to turn it on.
 */
const SECTIONS = [
  ...DATA_VIEWS.filter((v) => v.view === "overview"),
  ...DATA_VIEWS.filter((v) => v.view !== "overview"),
];

function hostingBase(orgSlug: string, project: Pick<SiteProject, "site">) {
  return `/api/${orgSlug}/hosting/${encodeURIComponent(project.site)}`;
}

function statusQuery(orgSlug: string, project: Pick<SiteProject, "site">) {
  return {
    queryKey: KEYS.analyticsStatus(orgSlug, project.site),
    queryFn: async () =>
      (await fetchJson(
        `${hostingBase(orgSlug, project)}/analytics/status`,
      )) as AnalyticsStatus,
    retry: false,
    staleTime: 30_000,
  };
}

export function useAnalyticsStatus(
  orgSlug: string,
  project: Pick<SiteProject, "site">,
) {
  return useQuery(statusQuery(orgSlug, project));
}

/** The projects registered in Deco Analytics, in the order given. */
export function useRegisteredSites(
  orgSlug: string,
  projects: readonly SiteProject[],
): { project: SiteProject; status: AnalyticsStatus }[] {
  const statuses = useQueries({
    queries: projects.map((p) => statusQuery(orgSlug, p)),
  });
  return projects.flatMap((project, i) => {
    const status = statuses[i]?.data;
    return status?.registered ? [{ project, status }] : [];
  });
}

/** The views a site has, overview first; none until it registers. */
export function analyticsSections(status: AnalyticsStatus | undefined) {
  return status?.registered ? SECTIONS : [];
}

/** Every view at least one of these sites is offered, in the usual order. */
export function unionSections(statuses: readonly AnalyticsStatus[]) {
  const offered = new Set(
    statuses.flatMap((s) => analyticsSections(s).map((v) => v.view)),
  );
  return SECTIONS.filter((v) => offered.has(v.view));
}

export function SectionTabs({
  sections,
  value,
  onChange,
}: {
  sections: ReturnType<typeof analyticsSections>;
  value: string;
  onChange: (section: string) => void;
}) {
  const t = useT();
  return (
    <Tabs value={value} onValueChange={onChange} variant="underline">
      <TabsList variant="underline" className="overflow-x-auto">
        {sections.map((s) => (
          <TabsTrigger key={s.view} value={s.view} variant="underline">
            {t(s.labelKey)}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

/** The site's Deco Analytics settings, behind a top-bar button. */
export function ConfigureDialog({
  orgSlug,
  project,
  status,
  open,
  onOpenChange,
}: {
  orgSlug: string;
  project: SiteProject;
  status: AnalyticsStatus;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("mainPanelTabs.analyticsTab.configSectionTitle")}
          </DialogTitle>
        </DialogHeader>
        <ConfigurationPanel
          base={hostingBase(orgSlug, project)}
          orgSlug={orgSlug}
          site={project.site}
          status={status}
        />
      </DialogContent>
    </Dialog>
  );
}

export function ConfigureButton({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <Button
      variant="outline"
      size="sm"
      className="font-normal"
      onClick={onClick}
    >
      <Settings01 size={14} />
      {t("mainPanelTabs.analyticsTab.configSectionTitle")}
    </Button>
  );
}

/** Turning Deco Analytics on for a site; the overview then reads it. */
export function RegisterAnalytics({
  orgSlug,
  project,
  status,
  onRegistered,
}: {
  orgSlug: string;
  project: SiteProject;
  status: AnalyticsStatus;
  onRegistered: (result: AnalyticsRegisterResult) => void;
}) {
  const queryClient = useQueryClient();
  return (
    <RegisterCard
      base={hostingBase(orgSlug, project)}
      orgSlug={orgSlug}
      site={project.site}
      host={status.host ?? null}
      onRegistered={(result) => {
        onRegistered(result);
        void queryClient.invalidateQueries({
          queryKey: KEYS.monitorAudienceSite(orgSlug, project.site),
        });
      }}
    />
  );
}
