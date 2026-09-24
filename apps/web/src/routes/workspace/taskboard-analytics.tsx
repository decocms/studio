/**
 * `/taskboard-analytics` — the two Grafana task board dashboards, readable by a
 * person and queryable by the agent from the same six tools.
 *
 * Additive: the kanban board itself is unchanged except for the button that
 * reaches this route.
 */

import { ChatLayout } from "@/components/chat-layout";
import { SectionView } from "@/layouts/task-board/analytics-sections";
import {
  ANALYTICS_TOOLS,
  useTaskBoardAdminOrgs,
  useTaskBoardAnalytics,
  type AnalyticsTool,
} from "@/hooks/use-task-board-analytics";
import { useT } from "@/i18n/use-t";
import { Button } from "@decocms/ui/components/button.tsx";
import { Combobox } from "@decocms/ui/components/combobox.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@decocms/ui/components/tabs.tsx";
import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";

const RANGE_DAYS = [7, 30, 90] as const;

const TAB_LABEL_KEYS = {
  TASK_BOARD_DELIVERY: "taskBoard.analytics.tabDelivery",
  TASK_BOARD_STUCK: "taskBoard.analytics.tabStuck",
  TASK_BOARD_COST: "taskBoard.analytics.tabCost",
  TASK_BOARD_QUALITY: "taskBoard.analytics.tabQuality",
  TASK_BOARD_ERRORS: "taskBoard.analytics.tabErrors",
  TASK_BOARD_TENANTS: "taskBoard.analytics.tabTenants",
} as const;

function ToolPanel({
  tool,
  org,
  from,
  to,
}: {
  tool: AnalyticsTool;
  org: string;
  from: string;
  to: string;
}) {
  const t = useT();
  const { data, isLoading, error } = useTaskBoardAnalytics(tool, {
    org,
    from,
    to,
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-lg border border-border p-8 text-center text-sm text-destructive">
        {error.message}
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="flex flex-col gap-8 py-6">
      {data.sections.map((section) => (
        <SectionView key={section.title} section={section} threadLinks />
      ))}
      <p className="text-xs text-muted-foreground">
        {t("taskBoard.analytics.rangeFootnote", {
          from: data.range.from.slice(0, 10),
          to: data.range.to.slice(0, 10),
        })}
      </p>
    </div>
  );
}

export default function TaskBoardAnalyticsRoute() {
  const t = useT();
  const orgSlug = useParams({ strict: false }).org ?? "";
  const admin = useTaskBoardAdminOrgs();
  const [days, setDays] = useState<number>(30);
  const [org, setOrg] = useState<string>(orgSlug);
  const [tab, setTab] = useState<AnalyticsTool>("TASK_BOARD_DELIVERY");
  // Frozen at mount so the range only moves when `days` does — a per-render
  // clock read would change the query key on every render.
  const [mountedAt] = useState(() => Date.now());

  const to = new Date(mountedAt).toISOString();
  const from = new Date(mountedAt - days * 86400_000).toISOString();

  const isAdmin = admin.data?.isTaskBoardAdmin ?? false;
  const orgOptions = [
    { value: orgSlug, label: t("taskBoard.analytics.orgCurrent") },
    { value: "all", label: t("taskBoard.analytics.orgAll") },
    ...(admin.data?.orgs ?? [])
      .filter((o) => o.slug !== orgSlug)
      .map((o) => ({ value: o.slug, label: `${o.slug} · ${o.name}` })),
  ];

  return (
    <ChatLayout.Content>
      <div className="flex h-full min-h-0 flex-col overflow-auto">
        <div className="mx-auto flex w-full max-w-[1680px] flex-col gap-4 px-4 py-6 sm:px-8 sm:py-8">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-medium text-foreground">
              {t("taskBoard.analytics.title")}
            </h1>
            <div className="ml-auto flex items-center gap-2">
              {isAdmin && (
                <Combobox
                  options={orgOptions}
                  value={org}
                  onChange={setOrg}
                  width="w-[240px]"
                  searchPlaceholder={t("taskBoard.analytics.orgSearch")}
                  emptyMessage={t("taskBoard.analytics.orgEmpty")}
                />
              )}
              <Select
                value={String(days)}
                onValueChange={(v) => setDays(Number(v))}
              >
                <SelectTrigger className="w-[140px]" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RANGE_DAYS.map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      {t("taskBoard.analytics.rangeDays", { days: String(d) })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" variant="outline" asChild>
                <Link to="/$org/tasks/{-$taskKey}" params={{ org: orgSlug }}>
                  {t("taskBoard.analytics.backToBoard")}
                </Link>
              </Button>
            </div>
          </div>

          {org !== orgSlug && (
            <div className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
              {org === "all"
                ? t("taskBoard.analytics.bannerAll")
                : t("taskBoard.analytics.bannerOrg", { org })}
            </div>
          )}

          <Tabs value={tab} onValueChange={(v) => setTab(v as AnalyticsTool)}>
            <TabsList>
              {ANALYTICS_TOOLS.map((tool) => (
                <TabsTrigger key={tool} value={tool}>
                  {t(TAB_LABEL_KEYS[tool])}
                </TabsTrigger>
              ))}
            </TabsList>
            {ANALYTICS_TOOLS.map((tool) => (
              <TabsContent key={tool} value={tool}>
                {tab === tool && (
                  <ToolPanel tool={tool} org={org} from={from} to={to} />
                )}
              </TabsContent>
            ))}
          </Tabs>
        </div>
      </div>
    </ChatLayout.Content>
  );
}
