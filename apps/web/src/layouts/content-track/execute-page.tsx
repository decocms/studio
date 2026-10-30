/**
 * Execute: the code track, the task board where agents build, and the content
 * track, where they write the brand's posts. One page, two tracks, chosen by
 * `?track=`; the org's and each project's Execute render the same page.
 */

import { lazy, Suspense, type ReactNode } from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { Page } from "@/components/page";
import { FeatureGate } from "@/components/paywall/feature-gate";
import { mockBoardAnswer } from "@/components/paywall/mock-board";
import { PaywallBackdrop } from "@/components/paywall/paywall-backdrop";
import { useFeature, useFeaturesSettled } from "@/hooks/use-entitlements";
import { useOrgFlagState } from "@/hooks/use-organization-settings";
import { useProjectFirstNav } from "@/hooks/use-preferences";
import { useT } from "@/i18n/use-t.ts";
import { TaskBoardPage } from "@/layouts/task-board";
import { KEYS } from "@/lib/query-keys";
import { useProjectContext } from "@/sdk";
import { resolveExecuteTrack, type Track } from "./track-state";

const ContentTrack = lazy(() =>
  import("./content-track").then((m) => ({ default: m.ContentTrack })),
);

function TrackTabs({
  track,
  onSelect,
}: {
  track: Track;
  onSelect: (track: Track) => void;
}) {
  const t = useT();
  return (
    <>
      <Page.Tab active={track === "code"} onClick={() => onSelect("code")}>
        <span aria-hidden className="size-2 rounded-full bg-brand-blue" />
        {t("contentTrack.trackCode")}
      </Page.Tab>
      <Page.Tab
        active={track === "content"}
        onClick={() => onSelect("content")}
      >
        <span aria-hidden className="size-2 rounded-full bg-success" />
        {t("contentTrack.trackContent")}
        <Badge variant="lime" size="sm">
          {t("common.new")}
        </Badge>
      </Page.Tab>
    </>
  );
}

function CodeTrack({ trackTabs }: { trackTabs: ReactNode }) {
  const { locator } = useProjectContext();
  const board = (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <TaskBoardPage trackTabs={trackTabs} />
    </div>
  );
  return (
    <FeatureGate
      feature="kanban"
      backdrop={
        <PaywallBackdrop
          seed={(client) =>
            client.setQueryData(KEYS.taskBoardItems(locator), mockBoardAnswer())
          }
        >
          {board}
        </PaywallBackdrop>
      }
    >
      {board}
    </FeatureGate>
  );
}

function TrackPending() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="min-h-0 w-full flex-1" />
    </div>
  );
}

export function ExecutePage() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as {
    track?: Track;
    boardOrg?: string;
  };
  const { taskKey } = useParams({ strict: false }) as { taskKey?: string };
  const projectFirstNav = useProjectFirstNav();
  const blogAi = useOrgFlagState("blog_ai_enabled");
  const kanban = useFeature("kanban");
  const plansSettled = useFeaturesSettled();

  const track = resolveExecuteTrack({
    track: search.track,
    taskKey,
    boardOrg: search.boardOrg,
    projectFirstNav,
    blogAi,
    kanban: plansSettled ? kanban : undefined,
  });
  if (track === "pending") return <TrackPending />;

  const contentAvailable =
    !taskKey && !search.boardOrg && projectFirstNav && blogAi === true;
  const select = (next: Track) =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        track: next,
        // Each track reads `view` its own way, and a card is the content's.
        view: undefined,
        card: undefined,
      }),
    });
  const trackTabs = contentAvailable ? (
    <TrackTabs track={track} onSelect={select} />
  ) : null;

  if (track === "content") {
    return (
      <Suspense fallback={<TrackPending />}>
        <ContentTrack trackTabs={trackTabs} />
      </Suspense>
    );
  }
  return <CodeTrack trackTabs={trackTabs} />;
}
