/**
 * The Calendar view of a Blocks (v8) site: its campaigns (the saved block
 * `campaigns`, type `calendar`) on a timeline, in the draft the site editor
 * works in. It is the content browser's Campaigns view on its own page, with
 * the same draft bar on top, so a campaign changes the same draft as the
 * pages and goes live with the same Publish. Production is never written.
 */

import { Calendar } from "@untitledui/icons";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { useOptionalChatTask } from "@/components/chat/chat-context";
import { CampaignsView } from "@/components/sandbox/content/campaigns/campaigns-view";
import { useContentBackend } from "@/components/sections-editor/use-content-backend";
import { useDecofile } from "@/components/sections-editor/use-decofile";
import { useLiveMeta } from "@/components/sections-editor/use-live-meta";
import { useT } from "@/i18n/use-t.ts";
import { useProjectContext } from "@/sdk";
import { isSiteNotOwned, SiteNotOwnedState } from "./blocks-tab-states";
import { contentSearchForUse } from "./experiments-v8-model";
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

function CalendarGuide({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <EmptyState
        icon={<Calendar size={28} className="text-muted-foreground" />}
        title={title}
        description={description}
        buttonProps={
          action
            ? { children: action.label, onClick: action.onClick }
            : undefined
        }
      />
    </div>
  );
}

export function CalendarTab({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const { org } = useProjectContext();
  const task = useOptionalChatTask();
  const branch = task?.currentBranch ?? null;
  const backend = useContentBackend(virtualMcpId, branch);
  const { openPanel } = usePanelNavigate();

  if (!branch) {
    return (
      <CalendarGuide
        title={t("sandbox.calendarView.noDraft.title")}
        description={t("sandbox.calendarView.noDraft.desc")}
        action={{
          label: t("sandbox.calendarView.openEditor"),
          onClick: () => openPanel("content"),
        }}
      />
    );
  }
  if (isSiteNotOwned(backend)) return <SiteNotOwnedState />;
  if (backend.kind === "pending") return <CalendarTabSkeleton />;
  if (backend.kind !== "protocol") {
    return (
      <CalendarGuide
        title={t("sandbox.calendarView.loadFailed")}
        description={t("sectionsEditor.namedRules.unavailableHint")}
      />
    );
  }
  return (
    <CalendarReady
      orgSlug={org.slug}
      virtualMcpId={virtualMcpId}
      branch={branch}
      threadId={task?.taskId ?? null}
    />
  );
}

function CalendarReady({
  orgSlug,
  virtualMcpId,
  branch,
  threadId,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  threadId: string | null;
}) {
  const t = useT();
  const { openPanel } = usePanelNavigate();
  const params = { orgSlug, virtualMcpId, branch, threadId, previewUrl: null };
  const decofileQuery = useDecofile(params);
  const metaQuery = useLiveMeta(params);
  const decofile = decofileQuery.data as Record<string, unknown> | undefined;
  const meta = metaQuery.data;

  if (!decofile || !meta) {
    if (decofileQuery.isError || metaQuery.isError) {
      return (
        <CalendarGuide
          title={t("sandbox.calendarView.loadFailed")}
          description={t("sandbox.calendarView.loadFailedHint")}
          action={{
            label: t("sandbox.calendarView.tryAgain"),
            onClick: () => {
              void decofileQuery.refetch();
              void metaQuery.refetch();
            },
          }}
        />
      );
    }
    return <CalendarTabSkeleton />;
  }

  return (
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
  );
}
