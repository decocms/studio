/** The board's analytics — the same tools Super Agent queries, for a person. */

import { CollectionTabs } from "@/components/collections/collection-tabs.tsx";
import { Page } from "@/components/page";
import {
  ANALYTICS_TOOLS,
  type AnalyticsTool,
  useTaskBoardAnalytics,
  useTaskBoardOperationTasks,
} from "@/hooks/use-task-board-analytics";
import { useT } from "@/i18n/use-t";
import {
  TimeRangePicker,
  type TimeRange,
} from "@decocms/ui/components/time-range-picker.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@decocms/ui/components/sheet.tsx";
import { expressionToDate } from "@decocms/ui/lib/time-expressions.ts";
import { cn } from "@decocms/ui/lib/utils.ts";
import { type ReactNode, useState } from "react";
import {
  DrillList,
  type DrillTarget,
  SectionView,
  sectionSpan,
} from "./analytics-sections";

const TAB_LABEL_KEYS = {
  TASK_BOARD_OPERATION: "taskBoard.analytics.tabOperation",
  TASK_BOARD_REWORK: "taskBoard.analytics.tabRework",
  TASK_BOARD_DELIVERY: "taskBoard.analytics.tabDelivery",
  TASK_BOARD_SPRINTS: "taskBoard.analytics.tabSprints",
  TASK_BOARD_STUCK: "taskBoard.analytics.tabStuck",
  TASK_BOARD_COST: "taskBoard.analytics.tabCost",
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

/** The cards behind the figure someone clicked. */
function DrillSheet({
  target,
  open,
  onOpenChange,
  params,
  taskHref,
}: {
  target: DrillTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  params: { org?: string; project?: string; from: string; to: string };
  taskHref?: (taskId: string) => string;
}) {
  const t = useT();
  const { data, isLoading, error } = useTaskBoardOperationTasks(
    params,
    target?.drill ?? null,
  );
  const tasks = data?.sections.find((s) => s.kind === "table");
  const count = tasks?.rows.length ?? 0;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" size="lg">
        <SheetHeader>
          <SheetTitle>{target?.label}</SheetTitle>
          <SheetDescription>
            {tasks
              ? t(
                  count === 1
                    ? "taskBoard.analytics.drillCountOne"
                    : "taskBoard.analytics.drillCount",
                  { n: String(count) },
                )
              : "\u00a0"}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {isLoading ? (
            <div className="flex flex-col gap-2 p-2" aria-busy>
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="h-11 animate-pulse rounded bg-muted" />
              ))}
            </div>
          ) : error ? (
            <p className="p-2 text-sm text-destructive">{error.message}</p>
          ) : (
            tasks?.kind === "table" && (
              <DrillList section={tasks} taskHref={taskHref} />
            )
          )}
        </div>
      </SheetContent>
    </Sheet>
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
  const params = { org, project, ...range };
  const { data, isPending, error } = useTaskBoardAnalytics(tool, params);
  // Kept after closing so the title stays put while the sheet slides out.
  const [drill, setDrill] = useState<DrillTarget | null>(null);
  const [drillOpen, setDrillOpen] = useState(false);

  if (error) {
    return (
      <div className="surface p-8 text-center text-sm text-destructive">
        {error.message}
      </div>
    );
  }
  // Pending, not just loading: a retrying request still has nothing to show.
  if (isPending || !data) return <LoadingGrid />;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {data.sections.map((section) => (
          <div
            key={section.title}
            className={cn(
              "min-w-0",
              sectionSpan(section) === "full" && "md:col-span-2",
              // A titled section sits a Settings section's distance away.
              section.kind === "table" && "mt-6",
            )}
          >
            <SectionView
              section={section}
              threadLinks
              showOrg={org === "all"}
              taskHref={taskHref}
              range={data.range}
              onDrill={(target) => {
                setDrill(target);
                setDrillOpen(true);
              }}
            />
          </div>
        ))}
      </div>
      <DrillSheet
        target={drill}
        open={drillOpen}
        onOpenChange={setDrillOpen}
        params={params}
        taskHref={taskHref}
      />
    </div>
  );
}

export function BoardAnalytics({
  org,
  project,
  taskHref,
  actions,
  notice,
  showTenants,
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
  /** The per-tenant tab; it only says something to a cross-org admin. */
  showTenants?: boolean;
}) {
  const t = useT();
  const [tab, setTab] = useState<AnalyticsTool>("TASK_BOARD_OPERATION");
  const [range, setRange] = useState<TimeRange>({
    from: "now-30d",
    to: "now",
  });
  const [resolved, setResolved] = useState(() => resolveRange(range));
  const tabs = ANALYTICS_TOOLS.filter(
    (tool) => tool !== "TASK_BOARD_TENANTS" || showTenants,
  ).map((tool) => ({
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
