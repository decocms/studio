/**
 * The Calendar view of a Blocks (v8) site: its campaigns (the saved block
 * `campaigns`, type `calendar`) on a timeline, in the draft the site editor
 * works in. It is the content browser's Campaigns view on its own page, with
 * the same draft bar on top, so a campaign changes the same draft as the
 * pages and goes live with the same Publish. Production is never written.
 */

import { Calendar } from "@untitledui/icons";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { CampaignsView } from "@/components/sandbox/content/campaigns/campaigns-view";
import { useT } from "@/i18n/use-t.ts";
import { contentSearchForUse } from "./experiments-v8-model";
import { SiteDraftView } from "./site-draft-view";
import { usePanelNavigate } from "./use-panel-navigate";

export function CalendarTabSkeleton() {
  return (
    <div
      className="flex flex-col gap-3 p-4"
      data-testid="calendar-skeleton"
      aria-busy="true"
    >
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

export function CalendarTab({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const { openPanel } = usePanelNavigate();
  return (
    <SiteDraftView
      virtualMcpId={virtualMcpId}
      icon={<Calendar size={28} className="text-muted-foreground" />}
      copy={{
        noDraftTitle: t("sandbox.calendarView.noDraft.title"),
        noDraftDesc: t("sandbox.calendarView.noDraft.desc"),
        loadFailed: t("sandbox.calendarView.loadFailed"),
        loadFailedHint: t("sandbox.calendarView.loadFailedHint"),
      }}
      skeleton={<CalendarTabSkeleton />}
    >
      {({ orgSlug, branch, decofile, meta }) => (
        <div className="h-full w-full" data-testid="calendar-view">
          <CampaignsView
            orgSlug={orgSlug}
            virtualMcpId={virtualMcpId}
            branch={branch}
            decofile={decofile}
            meta={meta}
            initialView="timeline"
            onOpenUse={(row) =>
              openPanel("content", {
                search: (prev) => ({ ...prev, ...contentSearchForUse(row) }),
              })
            }
          />
        </div>
      )}
    </SiteDraftView>
  );
}
