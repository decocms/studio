/**
 * Automation Runs View
 *
 * Shared per-automation run history: stat cards (runs, success rate, tokens,
 * cost) backed by AUTOMATION_RUN_STATS, plus a paginated runs table built from
 * the automation's run threads (COLLECTION_THREADS_LIST filtered by the
 * automation's trigger IDs, decorated with MONITORING_THREAD_USAGE). Clicking a
 * run opens its conversation in a Sheet.
 *
 * Used both on the automation detail page ("Runs" tab) and the Monitoring →
 * Automations tab. The Sheet (not the chat panel) is used so it works in the
 * settings layout, which has no chat panel.
 */

import { useState } from "react";
import {
  useMCPClient,
  useConnections,
  useVirtualMCPs,
  useProjectContext,
  SELF_MCP_ALIAS_ID,
} from "@/sdk";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Card } from "@deco/ui/components/card.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { Sheet, SheetContent } from "@deco/ui/components/sheet.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@deco/ui/components/table.tsx";
import { EmptyState } from "@/components/empty-state.tsx";
import { useInfiniteScroll } from "@/hooks/use-infinite-scroll.ts";
import { useMembers } from "@/hooks/use-members";
import { KEYS } from "@/lib/query-keys";
import { STATUS_CONFIG } from "@/lib/task-status";
import { useAutomationRunStats } from "@/hooks/use-automations";
import { useStudioTools } from "@/lib/studio-tools";
import { useT } from "@/i18n/use-t.ts";
import {
  ThreadSheetBody,
  type ThreadEntity,
  type ThreadUsage,
} from "@/routes/orgs/monitoring/threads.tsx";
import {
  formatCompactNumber,
  formatUsd,
} from "@/routes/orgs/monitoring/utils.ts";

const RUNS_PAGE_SIZE = 50;

// ── Stat cards ───────────────────────────────────────────────────────────────

function StatCard({
  title,
  value,
  subtitle,
}: {
  title: string;
  value: string;
  subtitle?: string;
}) {
  return (
    <Card className="pt-4 px-4 pb-5 gap-1">
      <span className="text-sm text-foreground/70">{title}</span>
      <span className="text-3xl font-normal tabular-nums">{value}</span>
      {subtitle && (
        <span className="text-xs text-muted-foreground">{subtitle}</span>
      )}
    </Card>
  );
}

function RunStatCards({
  automationId,
  range,
}: {
  automationId: string;
  range: { startDate?: string; endDate?: string };
}) {
  const t = useT();
  const { data, isLoading } = useAutomationRunStats(automationId, range);

  const runs = data?.runs;
  const usage = data?.usage;
  const successRate =
    runs && runs.total > 0
      ? `${Math.round((runs.completed / runs.total) * 100)}%`
      : "—";
  const usageSubtitle = usage
    ? usage.truncated
      ? t("automations.automationRuns.lastRunsSubtitle", {
          count: usage.sampledRuns,
        })
      : undefined
    : undefined;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <StatCard
        title={t("automations.automationRuns.runsTitle")}
        value={isLoading ? "…" : (runs?.total.toLocaleString() ?? "0")}
        subtitle={
          runs
            ? `${runs.completed} ${t("automations.automationRuns.ok")} · ${runs.failed} ${t("automations.automationRuns.failed")}${runs.inProgress > 0 ? ` · ${runs.inProgress} ${t("automations.automationRuns.running")}` : ""}`
            : undefined
        }
      />
      <StatCard
        title={t("automations.automationRuns.successRateTitle")}
        value={isLoading ? "…" : successRate}
      />
      <StatCard
        title={t("automations.automationRuns.tokensTitle")}
        value={isLoading ? "…" : formatCompactNumber(usage?.totalTokens ?? 0)}
        subtitle={usageSubtitle}
      />
      <StatCard
        title={t("automations.automationRuns.costTitle")}
        value={
          isLoading
            ? "…"
            : usage && usage.costUsd > 0
              ? formatUsd(usage.costUsd)
              : "—"
        }
        subtitle={usageSubtitle}
      />
    </div>
  );
}

// ── Runs table row ───────────────────────────────────────────────────────────

function RunRow({
  run,
  usage,
  onClick,
  lastRowRef,
}: {
  run: ThreadEntity;
  usage?: ThreadUsage;
  onClick: () => void;
  lastRowRef?: (node: HTMLTableRowElement | null) => void;
}) {
  const date = new Date(run.created_at);
  const dateStr = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const timeStr = date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });

  const statusCfg =
    STATUS_CONFIG[run.status as keyof typeof STATUS_CONFIG] ??
    STATUS_CONFIG.completed;
  const StatusIcon = statusCfg.icon;

  return (
    <TableRow
      ref={lastRowRef}
      className="h-14 cursor-pointer hover:bg-muted/40 transition-colors border-b-0"
      onClick={onClick}
    >
      <TableCell className="min-w-0 pr-2 pl-4 md:pr-4">
        <div className="font-medium text-foreground truncate">{run.title}</div>
      </TableCell>
      <TableCell className="w-28 px-3">
        <div className="flex items-center gap-1.5">
          <StatusIcon size={14} className={statusCfg.iconClassName} />
          <span className={cn("text-sm", statusCfg.labelColor)}>
            {statusCfg.label}
          </span>
        </div>
      </TableCell>
      <TableCell className="w-24 px-3 text-right tabular-nums text-muted-foreground">
        {usage ? formatCompactNumber(usage.totalTokens) : "—"}
      </TableCell>
      <TableCell className="w-24 px-3 text-right tabular-nums text-muted-foreground">
        {usage && usage.costUsd > 0 ? formatUsd(usage.costUsd) : "—"}
      </TableCell>
      <TableCell className="w-32 px-3 pr-5 text-muted-foreground">
        <div>{dateStr}</div>
        <div className="text-xs text-muted-foreground/60">{timeStr}</div>
      </TableCell>
    </TableRow>
  );
}

// ── Main view ────────────────────────────────────────────────────────────────

export function AutomationRunsView({
  automationId,
  triggerIds,
  range,
}: {
  automationId: string;
  triggerIds: string[];
  /** Window for the stat cards + table usage decoration. */
  range: { startDate?: string; endDate?: string };
}) {
  const t = useT();
  const { org, locator } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const studio = useStudioTools();
  const allConnections = useConnections();
  const allVirtualMcps = useVirtualMCPs();
  const { data: membersData } = useMembers();

  const [selectedRunIndex, setSelectedRunIndex] = useState<number | null>(null);

  const hasTriggers = triggerIds.length > 0;

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
    useInfiniteQuery({
      queryKey: KEYS.automationRuns(org.id, automationId, triggerIds),
      queryFn: async ({ pageParam = 0 }) => {
        return (await studio.call("COLLECTION_THREADS_LIST", {
          limit: RUNS_PAGE_SIZE,
          offset: pageParam,
          where: { trigger_ids: triggerIds },
        })) as {
          items: ThreadEntity[];
          totalCount: number;
          hasMore: boolean;
        };
      },
      initialPageParam: 0 as number,
      getNextPageParam: (lastPage, allPages) => {
        const page = lastPage as { items?: ThreadEntity[] } | undefined;
        const pages = allPages as Array<{ items?: ThreadEntity[] }>;
        if ((page?.items?.length ?? 0) < RUNS_PAGE_SIZE) return undefined;
        return pages.length * RUNS_PAGE_SIZE;
      },
      enabled: hasTriggers,
      staleTime: 30_000,
    });

  const runs = (data?.pages ?? []).flatMap(
    (p: { items?: ThreadEntity[] }) => p.items ?? [],
  );

  const threadIds = runs.map((r) => r.id);
  const { data: usageData } = useQuery({
    queryKey: KEYS.monitoringThreadUsage(
      locator,
      JSON.stringify({ ids: threadIds, ...range }),
    ),
    queryFn: async () => {
      return (await studio.call("MONITORING_THREAD_USAGE", {
        threadIds,
        ...(range.startDate ? { startDate: range.startDate } : {}),
        ...(range.endDate ? { endDate: range.endDate } : {}),
      })) as {
        items: Array<ThreadUsage & { threadId: string }>;
      };
    },
    enabled: threadIds.length > 0,
    staleTime: 30_000,
  });

  const usageMap = new Map<string, ThreadUsage>(
    (usageData?.items ?? []).map((u) => [
      u.threadId,
      {
        calls: u.calls,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        totalTokens: u.totalTokens,
        costUsd: u.costUsd,
      },
    ]),
  );

  const lastRowRef = useInfiniteScroll(
    () => {
      if (hasNextPage && !isFetchingNextPage) fetchNextPage();
    },
    hasNextPage ?? false,
    isFetchingNextPage,
  );

  const selectedRun =
    selectedRunIndex !== null ? (runs[selectedRunIndex] ?? null) : null;

  const handlePrev = () =>
    setSelectedRunIndex((i) => (i !== null && i > 0 ? i - 1 : i));
  const handleNext = () =>
    setSelectedRunIndex((i) => (i !== null && i < runs.length - 1 ? i + 1 : i));

  return (
    <div className="flex flex-col gap-5">
      <RunStatCards automationId={automationId} range={range} />

      {!hasTriggers ? (
        <div className="py-16">
          <EmptyState
            title={t("automations.automationRuns.noStartersTitle")}
            description={t("automations.automationRuns.noStartersDescription")}
          />
        </div>
      ) : isLoading ? (
        <div className="py-16 text-center text-sm text-muted-foreground">
          {t("automations.automationRuns.loadingRuns")}
        </div>
      ) : runs.length === 0 ? (
        <div className="py-16">
          <EmptyState
            title={t("automations.automationRuns.noRunsTitle")}
            description={t("automations.automationRuns.noRunsDescription")}
          />
        </div>
      ) : (
        <Table className="w-full border-collapse">
          <TableHeader className="border-b-0">
            <TableRow className="h-9 hover:bg-transparent border-b border-border">
              <TableHead className="pl-4 text-xs font-mono font-normal text-muted-foreground uppercase tracking-wide">
                {t("automations.automationRuns.runHeader")}
              </TableHead>
              <TableHead className="w-28 px-3 text-xs font-mono font-normal text-muted-foreground uppercase tracking-wide">
                {t("automations.automationRuns.statusHeader")}
              </TableHead>
              <TableHead className="w-24 px-3 text-xs font-mono font-normal text-muted-foreground uppercase tracking-wide text-right">
                {t("automations.automationRuns.tokensHeader")}
              </TableHead>
              <TableHead className="w-24 px-3 text-xs font-mono font-normal text-muted-foreground uppercase tracking-wide text-right">
                {t("automations.automationRuns.costHeader")}
              </TableHead>
              <TableHead className="w-32 px-3 pr-5 text-xs font-mono font-normal text-muted-foreground uppercase tracking-wide">
                {t("automations.automationRuns.startedHeader")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run, idx) => (
              <RunRow
                key={run.id}
                run={run}
                usage={usageMap.get(run.id)}
                onClick={() => setSelectedRunIndex(idx)}
                lastRowRef={
                  idx === runs.length - 1
                    ? (lastRowRef as (node: HTMLTableRowElement | null) => void)
                    : undefined
                }
              />
            ))}
          </TableBody>
        </Table>
      )}

      {isFetchingNextPage && (
        <div className="py-4 text-center text-sm text-muted-foreground">
          {t("automations.automationRuns.loadingMore")}
        </div>
      )}

      <Sheet
        open={selectedRunIndex !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedRunIndex(null);
        }}
      >
        <SheetContent className="sm:max-w-2xl flex flex-col p-0 gap-0">
          {selectedRun && selectedRunIndex !== null && (
            <ThreadSheetBody
              thread={selectedRun}
              client={client}
              locator={locator}
              connections={allConnections}
              virtualMcps={allVirtualMcps}
              members={membersData}
              selectedIndex={selectedRunIndex}
              total={runs.length}
              onPrev={handlePrev}
              onNext={handleNext}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
