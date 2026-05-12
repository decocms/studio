/**
 * Audit Tab — log table with detail sheet.
 */

import { useState } from "react";
import type { useConnections, useVirtualMCPs } from "@decocms/mesh-sdk";
import { useMCPClient } from "@decocms/mesh-sdk";
import type { useProjectContext } from "@decocms/mesh-sdk";
import { useQuery, useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@deco/ui/components/sheet.tsx";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@deco/ui/components/table.tsx";
import { ChevronUp, ChevronDown } from "@untitledui/icons";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { LogRow } from "@/web/components/monitoring/log-row.tsx";
import {
  ExpandedLogContent,
  type EnrichedMonitoringLog,
  type MonitoringLog,
  type MonitoringLogsResponse,
} from "@/web/components/monitoring";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { useInfiniteScroll } from "@/web/hooks/use-infinite-scroll.ts";
import type { useMembers } from "@/web/hooks/use-members";
import { KEYS } from "@/web/lib/query-keys";
import { getOrgMembers } from "./utils.ts";

// ── Logs Table ──────────────────────────────────────────────────────────────

interface MonitoringLogsTableProps {
  connectionIds: string[];
  virtualMcpIds: string[];
  tool: string;
  status: string;
  search: string;
  logs: MonitoringLogsResponse["logs"];
  hasMore: boolean;
  onLoadMore: () => void;
  isLoadingMore: boolean;
  connections: ReturnType<typeof useConnections>;
  virtualMcps: ReturnType<typeof useVirtualMCPs>;
  membersData: ReturnType<typeof useMembers>["data"];
  client: ReturnType<typeof useMCPClient>;
}

function MonitoringLogsTableContent({
  connectionIds,
  virtualMcpIds,
  tool,
  status,
  search: searchQuery,
  logs,
  hasMore,
  onLoadMore,
  isLoadingMore,
  connections: connectionsData,
  virtualMcps: virtualMcpsData,
  membersData,
  client,
}: MonitoringLogsTableProps) {
  const connections = connectionsData ?? [];
  const virtualMcps = virtualMcpsData ?? [];
  const [selectedLogIndex, setSelectedLogIndex] = useState<number | null>(null);

  const lastLogRef = useInfiniteScroll(onLoadMore, hasMore, isLoadingMore);

  const members = getOrgMembers(membersData);
  const userMap = new Map(members.map((m) => [m.userId, m.user]));

  const virtualMcpMap = new Map(virtualMcps.map((vm) => [vm.id, vm]));

  const enrichedLogs: EnrichedMonitoringLog[] = logs.map((log) => {
    const user = userMap.get(log.userId ?? "");
    const virtualMcp = log.virtualMcpId
      ? virtualMcpMap.get(log.virtualMcpId)
      : null;
    return {
      ...log,
      userName: user?.name ?? log.userId ?? "Unknown",
      userImage: user?.image ?? undefined,
      virtualMcpName: virtualMcp?.title ?? null,
      virtualMcpIcon: virtualMcp?.icon ?? null,
    };
  });

  let filteredLogs = enrichedLogs;

  if (connectionIds.length > 1) {
    filteredLogs = filteredLogs.filter((log) =>
      connectionIds.includes(log.connectionId),
    );
  }

  if (virtualMcpIds.length > 1) {
    filteredLogs = filteredLogs.filter(
      (log) => log.virtualMcpId && virtualMcpIds.includes(log.virtualMcpId),
    );
  }

  const connectionMap = new Map(connections.map((c) => [c.id, c]));

  if (searchQuery) {
    const lowerQuery = searchQuery.toLowerCase();
    filteredLogs = filteredLogs.filter(
      (log) =>
        log.toolName.toLowerCase().includes(lowerQuery) ||
        (connectionMap.get(log.connectionId)?.title ?? log.connectionId)
          .toLowerCase()
          .includes(lowerQuery) ||
        log.errorMessage?.toLowerCase().includes(lowerQuery),
    );
  }

  const selectedLog =
    selectedLogIndex !== null ? (filteredLogs[selectedLogIndex] ?? null) : null;

  // Lazy-load full input/output when a log is selected (list query omits them)
  const detailQuery = useQuery({
    queryKey: KEYS.monitoringLogDetail(selectedLog?.id ?? ""),
    queryFn: async () => {
      if (!client) throw new Error("MCP client is not available");
      const result = (await client.callTool({
        name: "MONITORING_LOG_GET",
        arguments: { id: selectedLog!.id },
      })) as { structuredContent?: unknown };
      return (result.structuredContent ?? result) as {
        log: MonitoringLog | null;
      };
    },
    enabled: selectedLog !== null,
  });

  const detailLog = detailQuery.data?.log;
  const fullSelectedLog =
    selectedLog && detailLog
      ? { ...selectedLog, input: detailLog.input, output: detailLog.output }
      : selectedLog;

  if (filteredLogs.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <EmptyState
          image={
            <img
              src="/empty-state-logs.svg"
              alt=""
              width={336}
              height={320}
              aria-hidden="true"
            />
          }
          title="No logs found"
          description={
            searchQuery ||
            connectionIds.length > 0 ||
            virtualMcpIds.length > 0 ||
            tool ||
            status !== "all"
              ? "No logs match your filters"
              : "No logs found in this time range"
          }
        />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-w-0">
      <div className="flex-1 overflow-auto min-w-0">
        <div className="min-w-[600px] md:min-w-0">
          <Table className="w-full border-collapse">
            <TableHeader className="border-b-0 z-20">
              <TableRow className="h-9 hover:bg-transparent border-b border-border">
                <TableHead className="w-5" />
                <TableHead className="pr-2 md:pr-4 text-xs font-mono font-normal text-muted-foreground uppercase tracking-wide">
                  Tool / Connection
                </TableHead>
                <TableHead className="w-36 md:w-44 px-2 md:px-3 text-xs font-mono font-normal text-muted-foreground uppercase tracking-wide">
                  Agent
                </TableHead>
                <TableHead className="w-28 md:w-36 px-2 md:px-3 text-xs font-mono font-normal text-muted-foreground uppercase tracking-wide">
                  User
                </TableHead>
                <TableHead className="w-32 md:w-40 px-2 md:px-3 text-xs font-mono font-normal text-muted-foreground uppercase tracking-wide">
                  Date
                </TableHead>
                <TableHead className="w-16 md:w-20 px-2 md:px-3 text-xs font-mono font-normal text-muted-foreground uppercase tracking-wide">
                  Latency
                </TableHead>
                <TableHead className="w-16 md:w-24 px-2 md:px-3 text-xs font-mono font-normal text-muted-foreground uppercase tracking-wide text-right pr-3 md:pr-5">
                  Status
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredLogs.map((log, index) => (
                <LogRow
                  key={log.id}
                  log={log}
                  connection={connectionMap.get(log.connectionId)}
                  virtualMcpName={log.virtualMcpName ?? ""}
                  virtualMcpIcon={log.virtualMcpIcon}
                  onClick={() => setSelectedLogIndex(index)}
                  lastLogRef={
                    index === filteredLogs.length - 1 ? lastLogRef : undefined
                  }
                />
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <Sheet
        open={selectedLogIndex !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedLogIndex(null);
        }}
      >
        <SheetContent className="sm:max-w-2xl flex flex-col p-0 gap-0">
          {selectedLog && selectedLogIndex !== null && (
            <>
              <SheetHeader className="px-5 md:px-6 pt-6 pb-5 border-b border-border shrink-0">
                <div className="flex items-start justify-between gap-3 pr-8">
                  <div className="flex items-center gap-3 min-w-0">
                    <IntegrationIcon
                      icon={
                        connectionMap.get(selectedLog.connectionId)?.icon ||
                        null
                      }
                      name={
                        connectionMap.get(selectedLog.connectionId)?.title ??
                        selectedLog.connectionId
                      }
                      size="sm"
                      className="shadow-sm shrink-0"
                    />
                    <div className="min-w-0">
                      <SheetTitle className="text-sm leading-snug truncate">
                        {selectedLog.toolName}
                      </SheetTitle>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">
                        {connectionMap.get(selectedLog.connectionId)?.title ??
                          selectedLog.connectionId}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() =>
                        setSelectedLogIndex((i) =>
                          i !== null && i > 0 ? i - 1 : i,
                        )
                      }
                      disabled={selectedLogIndex === 0}
                      className="h-7 w-7 text-muted-foreground"
                      aria-label="Previous entry"
                    >
                      <ChevronUp size={14} />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() =>
                        setSelectedLogIndex((i) =>
                          i !== null && i < filteredLogs.length - 1 ? i + 1 : i,
                        )
                      }
                      disabled={selectedLogIndex === filteredLogs.length - 1}
                      className="h-7 w-7 text-muted-foreground"
                      aria-label="Next entry"
                    >
                      <ChevronDown size={14} />
                    </Button>
                  </div>
                </div>
              </SheetHeader>
              <div className="flex-1 overflow-y-auto min-h-0">
                {detailQuery.isLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <div className="size-5 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin" />
                  </div>
                ) : detailQuery.isError ? (
                  <div className="flex flex-col items-center justify-center py-12 gap-3 text-sm text-muted-foreground">
                    <p>Failed to load log details</p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => detailQuery.refetch()}
                    >
                      Retry
                    </Button>
                  </div>
                ) : (
                  <ExpandedLogContent log={fullSelectedLog!} />
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function MonitoringLogsTableSkeleton() {
  return (
    <div className="flex-1 flex flex-col overflow-auto min-w-0">
      <div className="mx-auto w-full max-w-[1200px] px-4 md:px-10 flex flex-col flex-1 min-h-0">
        <Table className="w-full border-collapse">
          <TableHeader className="border-b-0 z-20">
            <TableRow className="h-9 hover:bg-transparent border-b border-border">
              <TableHead className="w-12 md:w-16 px-2 md:px-4" />
              <TableHead className="pr-2 md:pr-4">
                <div className="h-3 w-24 rounded bg-muted animate-pulse" />
              </TableHead>
              <TableHead className="w-24 md:w-32 px-2 md:px-3">
                <div className="h-3 w-12 rounded bg-muted animate-pulse" />
              </TableHead>
              <TableHead className="w-20 md:w-24 px-2 md:px-3">
                <div className="h-3 w-16 rounded bg-muted animate-pulse" />
              </TableHead>
              <TableHead className="w-32 md:w-40 px-2 md:px-3">
                <div className="h-3 w-10 rounded bg-muted animate-pulse" />
              </TableHead>
              <TableHead className="w-16 md:w-20 px-2 md:px-3">
                <div className="h-3 w-10 rounded bg-muted animate-pulse ml-auto" />
              </TableHead>
              <TableHead className="w-16 md:w-24 px-2 md:px-3 pr-3 md:pr-5">
                <div className="h-3 w-12 rounded bg-muted animate-pulse ml-auto" />
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: 8 }).map((_, i) => (
              <TableRow
                key={i}
                className="h-14 border-b border-border hover:bg-transparent"
              >
                <td className="px-2 md:px-4">
                  <div className="size-5 rounded bg-muted animate-pulse" />
                </td>
                <td className="pr-2 md:pr-4">
                  <div className="space-y-1">
                    <div className="h-3.5 w-32 rounded bg-muted animate-pulse" />
                    <div className="h-2.5 w-20 rounded bg-muted animate-pulse" />
                  </div>
                </td>
                <td className="px-2 md:px-3">
                  <div className="h-3 w-16 rounded bg-muted animate-pulse" />
                </td>
                <td className="px-2 md:px-3">
                  <div className="h-3 w-14 rounded bg-muted animate-pulse" />
                </td>
                <td className="px-2 md:px-3">
                  <div className="h-3 w-16 rounded bg-muted animate-pulse" />
                </td>
                <td className="px-2 md:px-3">
                  <div className="space-y-1">
                    <div className="h-3 w-14 rounded bg-muted animate-pulse" />
                    <div className="h-2.5 w-20 rounded bg-muted animate-pulse" />
                  </div>
                </td>
                <td className="px-2 md:px-3">
                  <div className="h-3 w-10 rounded bg-muted animate-pulse ml-auto" />
                </td>
                <td className="px-2 md:px-3 pr-3 md:pr-5">
                  <div className="h-5 w-14 rounded-full bg-muted animate-pulse ml-auto" />
                </td>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export const MonitoringLogsTable = Object.assign(MonitoringLogsTableContent, {
  Skeleton: MonitoringLogsTableSkeleton,
});

// ── Audit Tab Content ───────────────────────────────────────────────────────

export interface AuditTabContentProps {
  client: ReturnType<typeof useMCPClient>;
  locator: ReturnType<typeof useProjectContext>["locator"];
  baseParams: Record<string, unknown>;
  pageSize: number;
  isStreaming: boolean;
  streamingRefetchInterval: number;
  connectionIds: string[];
  virtualMcpIds: string[];
  tool: string;
  status: string;
  searchQuery: string;
  allConnections: ReturnType<typeof useConnections>;
  allVirtualMcps: ReturnType<typeof useVirtualMCPs>;
  membersData: ReturnType<typeof useMembers>["data"];
}

export function AuditTabContent({
  client,
  locator,
  baseParams,
  pageSize,
  isStreaming,
  streamingRefetchInterval,
  connectionIds,
  virtualMcpIds,
  tool,
  status,
  searchQuery,
  allConnections,
  allVirtualMcps,
  membersData,
}: AuditTabContentProps) {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery({
      queryKey: KEYS.monitoringLogsInfinite(
        locator,
        JSON.stringify(baseParams),
      ),
      queryFn: async ({ pageParam = 0 }) => {
        if (!client) {
          throw new Error("MCP client is not available");
        }
        const result = (await client.callTool({
          name: "MONITORING_LOGS_LIST",
          arguments: {
            ...baseParams,
            limit: pageSize,
            offset: pageParam,
          },
        })) as { structuredContent?: unknown };
        return (result.structuredContent ?? result) as MonitoringLogsResponse;
      },
      initialPageParam: 0,
      getNextPageParam: (lastPage, allPages) => {
        if ((lastPage?.logs?.length ?? 0) < pageSize) {
          return undefined;
        }
        return allPages.length * pageSize;
      },
      staleTime: 0,
      refetchInterval: isStreaming ? streamingRefetchInterval : false,
    });

  const realLogs = data.pages.flatMap((page) => page.logs ?? []);

  const handleLoadMore = () => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-auto min-w-0">
      <div className="mx-auto w-full max-w-[1200px] px-4 md:px-10 flex flex-col flex-1 min-h-0">
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          <MonitoringLogsTable
            connectionIds={connectionIds}
            virtualMcpIds={virtualMcpIds}
            tool={tool}
            status={status}
            search={searchQuery}
            logs={realLogs}
            hasMore={hasNextPage ?? false}
            onLoadMore={handleLoadMore}
            isLoadingMore={isFetchingNextPage}
            connections={allConnections}
            virtualMcps={allVirtualMcps}
            membersData={membersData}
            client={client}
          />
        </div>
      </div>
    </div>
  );
}
