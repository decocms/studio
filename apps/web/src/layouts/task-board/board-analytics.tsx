/** The board's analytics — the same tools Super Agent queries, for a person. */

import { CollectionTabs } from "@/components/collections/collection-tabs.tsx";
import { Page } from "@/components/page";
import {
  ANALYTICS_TOOLS,
  type AnalyticsTool,
  useTaskBoardAnalytics,
} from "@/hooks/use-task-board-analytics";
import { useT } from "@/i18n/use-t";
import {
  TimeRangePicker,
  type TimeRange,
} from "@decocms/ui/components/time-range-picker.tsx";
import { expressionToDate } from "@decocms/ui/lib/time-expressions.ts";
import { cn } from "@decocms/ui/lib/utils.ts";
import { type ReactNode, useState } from "react";
import { SectionView, sectionSpan } from "./analytics-sections";

const TAB_LABEL_KEYS = {
  TASK_BOARD_OPERATION: "taskBoard.analytics.tabOperation",
  TASK_BOARD_DELIVERY: "taskBoard.analytics.tabDelivery",
  TASK_BOARD_STUCK: "taskBoard.analytics.tabStuck",
  TASK_BOARD_COST: "taskBoard.analytics.tabCost",
  TASK_BOARD_QUALITY: "taskBoard.analytics.tabQuality",
  TASK_BOARD_ERRORS: "taskBoard.analytics.tabErrors",
  TASK_BOARD_TENANTS: "taskBoard.analytics.tabTenants",
} as const;

/** `now-30d`-style expressions, resolved once per pick so the query key holds
 *  still between renders. */
function resolveRange(range: TimeRange): { from: string; to: string } {
  const now = new Date();
  return {
    from: (expressionToDate(range.from).date ?? now).toISOString(),
    to: (expressionToDate(range.to).date ?? now).toISOString(),
  };
}

function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={cn("surface flex flex-col gap-6 p-4", className)}>
      <div className="flex flex-col gap-1">
        <div className="h-5 w-24 animate-pulse rounded bg-muted" />
        <div className="h-10 w-16 animate-pulse rounded bg-muted" />
      </div>
      <div className="h-[140px] w-full animate-pulse rounded bg-muted/60" />
    </div>
  );
}

function LoadingGrid() {
  return (
    <div className="flex flex-col gap-4" aria-busy>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="surface flex flex-col gap-1 p-4">
            <div className="h-5 w-24 animate-pulse rounded bg-muted" />
            <div className="h-10 w-16 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <SkeletonCard />
        <SkeletonCard />
      </div>
      <SkeletonCard />
    </div>
  );
}

function ToolPanel({
  tool,
  org,
  project,
  range,
  taskHref,
}: {
  tool: AnalyticsTool;
  org?: string;
  project?: string;
  range: { from: string; to: string };
  taskHref?: (taskId: string) => string;
}) {
  const t = useT();
  const { data, isLoading, error } = useTaskBoardAnalytics(tool, {
    org,
    project,
    ...range,
  });

  if (isLoading) return <LoadingGrid />;
  if (error) {
    return (
      <div className="surface p-8 text-center text-sm text-destructive">
        {error.message}
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {data.sections.map((section) => (
          <div
            key={section.title}
            className={cn(
              "min-w-0",
              sectionSpan(section) === "full" && "md:col-span-2",
            )}
          >
            <SectionView
              section={section}
              threadLinks
              showOrg={org === "all"}
              taskHref={taskHref}
              range={data.range}
            />
          </div>
        ))}
      </div>
      {/* Stuck is "right now", whatever the range says. */}
      {tool !== "TASK_BOARD_STUCK" && (
        <p className="text-meta">
          {t("taskBoard.analytics.rangeFootnote", {
            from: data.range.from.slice(0, 10),
            to: data.range.to.slice(0, 10),
          })}
        </p>
      )}
    </div>
  );
}

export function BoardAnalytics({
  org,
  project,
  taskHref,
  actions,
  notice,
}: {
  /** Org slug, or "all"; omitted for the current org. */
  org?: string;
  /** Narrow every tool to this project's cards. */
  project?: string;
  taskHref?: (taskId: string) => string;
  /** Page actions placed before the time range. */
  actions?: ReactNode;
  /** A line above the cards, e.g. whose data an admin is reading. */
  notice?: ReactNode;
}) {
  const t = useT();
  const [tab, setTab] = useState<AnalyticsTool>("TASK_BOARD_OPERATION");
  const [range, setRange] = useState<TimeRange>({
    from: "now-30d",
    to: "now",
  });
  const [resolved, setResolved] = useState(() => resolveRange(range));
  const tabs = ANALYTICS_TOOLS.map((tool) => ({
    id: tool,
    label: t(TAB_LABEL_KEYS[tool]),
  }));

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      <Page.Actions>
        {actions}
        <TimeRangePicker
          value={range}
          onChange={(next) => {
            setRange(next);
            setResolved(resolveRange(next));
          }}
          labels={{
            absoluteTimeRange: t(
              "monitoring.timeRangePicker.absoluteTimeRange",
            ),
            from: t("monitoring.timeRangePicker.from"),
            to: t("monitoring.timeRangePicker.to"),
            applyTimeRange: t("monitoring.timeRangePicker.applyTimeRange"),
          }}
          quickRanges={[
            {
              label: t("monitoring.timeRangePicker.last7Days"),
              from: "now-7d",
              to: "now",
              value: "7d",
            },
            {
              label: t("monitoring.timeRangePicker.last30Days"),
              from: "now-30d",
              to: "now",
              value: "30d",
            },
            {
              label: t("monitoring.timeRangePicker.last90Days"),
              from: "now-90d",
              to: "now",
              value: "90d",
            },
          ]}
        />
      </Page.Actions>
      <CollectionTabs
        placement="page"
        tabs={tabs}
        activeTab={tab}
        onTabChange={(id) => {
          const next = ANALYTICS_TOOLS.find((tool) => tool === id);
          if (next) setTab(next);
        }}
      />
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-4 pt-6 pb-10 md:px-10">
        {notice}
        <ToolPanel
          key={tab}
          tool={tab}
          org={org}
          project={project}
          range={resolved}
          taskHref={taskHref}
        />
      </div>
    </div>
  );
}
