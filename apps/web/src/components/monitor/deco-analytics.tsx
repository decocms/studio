/** A site's Deco Analytics status, registration and settings. */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings01 } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { useT } from "@/i18n/use-t.ts";
import {
  type AnalyticsRegisterResult,
  type AnalyticsStatus,
  ConfigurationPanel,
  fetchJson,
  RegisterCard,
} from "@/layouts/main-panel-tabs/analytics-tab";
import { KEYS } from "@/lib/query-keys";
import type { SiteProject } from "./org-insights";

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
  enabled = true,
) {
  return useQuery({ ...statusQuery(orgSlug, project), enabled });
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
