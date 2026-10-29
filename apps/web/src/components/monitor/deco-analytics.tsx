/**
 * The Deco Analytics views beyond the Analytics tab's overview (realtime,
 * pages, events, errors, vitals, heatmap, quality, usage) and the site's
 * registration, reusing the per-site Analytics app's screens. Only a site
 * registered in Deco Analytics has them; OneDollarStats has only the overview.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { gateViews } from "@/layouts/main-panel-tabs/analytics-heatmap-model";
import { HeatmapView } from "@/layouts/main-panel-tabs/analytics-heatmap-tab";
import {
  ActiveView,
  type AnalyticsRegisterResult,
  type AnalyticsStatus,
  ConfigurationPanel,
  DATA_VIEWS,
  fetchJson,
  RegisterCard,
} from "@/layouts/main-panel-tabs/analytics-tab";
import { KEYS } from "@/lib/query-keys";
import type { SiteProject } from "./org-insights";

/** Overview first, as the tab opens on it; experiments have their own Monitor tab. */
const SECTIONS = [
  ...DATA_VIEWS.filter((v) => v.view === "overview"),
  ...DATA_VIEWS.filter(
    (v) => v.view !== "overview" && v.view !== "experiments",
  ),
];

/** Realtime is always "now" and the heatmap picks its own period. */
export function ownsRange(section: string): boolean {
  return section === "live" || section === "heatmap";
}

function hostingBase(orgSlug: string, project: Pick<SiteProject, "site">) {
  return `/api/${orgSlug}/hosting/${encodeURIComponent(project.site)}`;
}

export function useAnalyticsStatus(
  orgSlug: string,
  project: Pick<SiteProject, "site">,
) {
  return useQuery({
    queryKey: KEYS.analyticsStatus(orgSlug, project.site),
    queryFn: async () =>
      (await fetchJson(
        `${hostingBase(orgSlug, project)}/analytics/status`,
      )) as AnalyticsStatus,
    retry: false,
    staleTime: 30_000,
  });
}

/** The views this site is offered, overview first; none until it registers. */
export function analyticsSections(status: AnalyticsStatus | undefined) {
  if (!status?.registered) return [];
  return gateViews(SECTIONS, status.config?.modules ?? ["core"]);
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

export function AnalyticsSection({
  orgSlug,
  project,
  status,
  section,
  range,
  onConfigure,
}: {
  orgSlug: string;
  project: SiteProject;
  status: AnalyticsStatus;
  section: string;
  range: string;
  onConfigure: () => void;
}) {
  const base = hostingBase(orgSlug, project);
  if (section === "heatmap") {
    return (
      <HeatmapView
        base={base}
        orgSlug={orgSlug}
        site={project.site}
        modules={status.config?.modules ?? ["core"]}
        domain={status.config?.domains?.[0] ?? status.host ?? null}
        onConfigure={onConfigure}
      />
    );
  }
  return (
    <ActiveView
      key={section}
      base={base}
      orgSlug={orgSlug}
      site={project.site}
      view={section}
      range={range}
      quota={status.config?.quota}
    />
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
