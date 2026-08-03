/**
 * Threads Tab — thread list with conversation sheet.
 */

import { Suspense, useState } from "react";
import type { useConnections, useVirtualMCPs } from "@/sdk";
import { useMCPClient } from "@/sdk";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import {
  useInfiniteQuery,
  useQuery,
  useSuspenseInfiniteQuery,
} from "@tanstack/react-query";
import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@deco/ui/components/sheet.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@deco/ui/components/table.tsx";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { ChevronUp, ChevronDown, Container } from "@untitledui/icons";
import { EmptyState } from "@/components/empty-state.tsx";
import { ErrorBoundary } from "@/components/error-boundary";
import {
  MessagePair,
  useMessagePairs,
} from "@/components/chat/message/pair.tsx";
import type { ChatMessage } from "@/components/chat/types.ts";
import type {
  StudioThread as Thread,
  StudioThreadMessage as ThreadMessage,
} from "@decocms/shared/entities";
import { IntegrationIcon } from "@/components/integration-icon.tsx";
import { useInfiniteScroll } from "@/hooks/use-infinite-scroll.ts";
import type { useMembers } from "@/hooks/use-members";
import { KEYS } from "@/lib/query-keys";
import { STATUS_CONFIG } from "@/lib/task-status";
import {
  formatCompactNumber,
  formatUsd,
  getOrgMembers,
  getThreadAgentId,
  resolveAgentIcon,
  resolveAgentName,
} from "./utils.ts";

// ── Per-thread usage (tokens + cost), keyed by thread id ────────────────────

export interface ThreadUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

type ThreadSortKey = "tokens" | "cost";

// ── Thread types (pick only the fields we need from the server types) ───────

export type ThreadEntity = Pick<
  Thread,
  | "id"
  | "title"
  | "status"
  | "created_by"
  | "created_at"
  | "updated_at"
  | "virtual_mcp_id"
>;

type ThreadMessageEntity = Pick<
  ThreadMessage,
  | "id"
  | "thread_id"
  | "role"
  | "parts"
  | "metadata"
  | "created_at"
  | "updated_at"
>;

// ── Sheet header (extracted to avoid repetition) ────────────────────────────

function ThreadSheetHeader({
  thread,
  connections,
  virtualMcps,
  selectedIndex,
  total,
  onPrev,
  onNext,
}: {
  thread: ThreadEntity;
  connections: ReturnType<typeof useConnections>;
  virtualMcps: ReturnType<typeof useVirtualMCPs>;
  selectedIndex: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const t = useT();
  const agentId = getThreadAgentId(thread);
  const agentName = resolveAgentName(agentId, virtualMcps, connections, "");
  const agentIcon = resolveAgentIcon(agentId, virtualMcps, connections);

  return (
    <SheetHeader className="px-5 md:px-6 pt-6 pb-5 border-b border-border shrink-0">
      <div className="flex items-start justify-between gap-3 pr-8">
        <div className="flex items-center gap-3 min-w-0">
          <IntegrationIcon
            icon={agentIcon}
            name={agentName || thread.title}
            size="sm"
            fallbackIcon={<Container />}
            className="shadow-sm shrink-0 rounded-md"
          />
          <div className="min-w-0">
            <SheetTitle className="text-sm leading-snug truncate">
              {thread.title}
            </SheetTitle>
            {agentName && (
              <p className="text-xs text-muted-foreground mt-0.5 truncate">
                {agentName}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <Button
            size="icon"
            variant="ghost"
            onClick={onPrev}
            disabled={selectedIndex === 0}
            className="h-7 w-7 text-muted-foreground"
            aria-label={t("orgs.threads.previousChat")}
          >
            <ChevronUp size={14} />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={onNext}
            disabled={selectedIndex === total - 1}
            className="h-7 w-7 text-muted-foreground"
            aria-label={t("orgs.threads.nextChat")}
          >
            <ChevronDown size={14} />
          </Button>
        </div>
      </div>
    </SheetHeader>
  );
}

// ── Thread meta row ─────────────────────────────────────────────────────────

function ThreadMetaRow({
  thread,
  connections,
  virtualMcps,
  members,
}: {
  thread: ThreadEntity;
  connections: ReturnType<typeof useConnections>;
  virtualMcps: ReturnType<typeof useVirtualMCPs>;
  members: ReturnType<typeof useMembers>["data"] | undefined;
}) {
  const t = useT();
  const agentId = getThreadAgentId(thread);
  const agentName = resolveAgentName(agentId, virtualMcps, connections, "");
  const agentIcon = resolveAgentIcon(agentId, virtualMcps, connections);

  const membersList = getOrgMembers(members);
  const member = membersList.find((m) => m.userId === thread.created_by);
  const userName =
    member?.user.name ??
    member?.user.email ??
    thread.created_by?.substring(0, 8) ??
    "\u2014";
  const userImage = member?.user.image ?? undefined;

  const date = new Date(thread.created_at);
  const formattedDate = date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const statusCfg =
    STATUS_CONFIG[thread.status as keyof typeof STATUS_CONFIG] ??
    STATUS_CONFIG.completed;
  const StatusIcon = statusCfg.icon;

  return (
    <div className="px-5 md:px-6 py-5 border-b border-border grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4 text-sm">
      <div>
        <div className="text-xs text-muted-foreground mb-1">
          {t("orgs.threads.status")}
        </div>
        <div className="flex items-center gap-1.5">
          <StatusIcon size={13} className={statusCfg.iconClassName} />
          <span className={cn("text-sm", statusCfg.labelColor)}>
            {statusCfg.label}
          </span>
        </div>
      </div>

      <div>
        <div className="text-xs text-muted-foreground mb-1">
          {t("orgs.threads.date")}
        </div>
        <div className="text-sm text-foreground">{formattedDate}</div>
      </div>

      <div>
        <div className="text-xs text-muted-foreground mb-1">
          {t("orgs.threads.user")}
        </div>
        <div className="flex items-center gap-2">
          <Avatar
            url={userImage}
            fallback={userName}
            shape="circle"
            size="2xs"
            className="shrink-0"
          />
          <span className="text-sm text-foreground">{userName}</span>
        </div>
      </div>

      {agentName && (
        <div>
          <div className="text-xs text-muted-foreground mb-1">
            {t("orgs.threads.agent")}
          </div>
          <div className="flex items-center gap-2">
            <IntegrationIcon
              icon={agentIcon}
              name={agentName}
              size="xs"
              fallbackIcon={<Container />}
              className="shrink-0 size-5! min-w-5! rounded-md"
            />
            <span className="text-sm text-foreground">{agentName}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Thread row ──────────────────────────────────────────────────────────────

function ThreadRow({
  thread,
  usage,
  members,
  connections,
  virtualMcps,
  onClick,
  lastRowRef,
}: {
  thread: ThreadEntity;
  usage?: ThreadUsage;
  members: ReturnType<typeof useMembers>["data"] | undefined;
  connections: ReturnType<typeof useConnections>;
  virtualMcps: ReturnType<typeof useVirtualMCPs>;
  onClick: () => void;
  lastRowRef?: (node: HTMLTableRowElement | null) => void;
}) {
  const agentId = getThreadAgentId(thread);
  const agentName = resolveAgentName(
    agentId,
    virtualMcps,
    connections,
    "\u2014",
  );
  const agentIcon = resolveAgentIcon(agentId, virtualMcps, connections);

  const membersList = getOrgMembers(members);
  const member = membersList.find((m) => m.userId === thread.created_by);
  const userName =
    member?.user.name ??
    member?.user.email ??
    thread.created_by?.substring(0, 8) ??
    "\u2014";
  const userImage = member?.user.image ?? undefined;

  const date = new Date(thread.created_at);
  const dateStr = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const timeStr = date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });

  const statusCfg =
    STATUS_CONFIG[thread.status as keyof typeof STATUS_CONFIG] ??
    STATUS_CONFIG.completed;
  const StatusIcon = statusCfg.icon;

  return (
    <TableRow
      ref={lastRowRef}
      className="h-14 md:h-16 cursor-pointer hover:bg-muted/40 transition-colors border-b-0"
      onClick={onClick}
    >
      <TableCell className="min-w-0 pr-2 pl-4 md:pr-4">
        <div className="font-medium text-foreground truncate">
          {thread.title}
        </div>
      </TableCell>
      <TableCell className="w-36 px-3 text-muted-foreground">
        <div className="flex items-center gap-2 min-w-0">
          <IntegrationIcon
            icon={agentIcon}
            name={agentName}
            size="xs"
            fallbackIcon={<Container />}
            className="shrink-0 size-5! min-w-5! rounded-md"
          />
          <span className="truncate">{agentName}</span>
        </div>
      </TableCell>
      <TableCell className="w-28 px-3 text-muted-foreground">
        <div className="flex items-center gap-2 min-w-0">
          <Avatar
            url={userImage}
            fallback={userName}
            shape="circle"
            size="2xs"
            className="shrink-0"
          />
          <span className="truncate">{userName}</span>
        </div>
      </TableCell>
      <TableCell className="w-24 px-3">
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

// ── Conversation panel ──────────────────────────────────────────────────────

const MESSAGES_PAGE_SIZE = 100;

function ThreadConversationPanelEmpty() {
  const t = useT();
  return (
    <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
      {t("orgs.threads.noMessagesInChat")}
    </div>
  );
}

function ThreadConversationPanelLoading() {
  const t = useT();
  return (
    <div className="py-4 text-center text-xs text-muted-foreground">
      {t("orgs.threads.loadingMore")}
    </div>
  );
}

function ThreadConversationPanel({
  client,
  locator,
  thread,
  connections,
  virtualMcps,
  members,
  selectedIndex,
  total,
  onPrev,
  onNext,
}: {
  client: ReturnType<typeof useMCPClient>;
  locator: string;
  thread: ThreadEntity;
  connections: ReturnType<typeof useConnections>;
  virtualMcps: ReturnType<typeof useVirtualMCPs>;
  members: ReturnType<typeof useMembers>["data"] | undefined;
  selectedIndex: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery({
      queryKey: KEYS.threadMessages(locator, thread.id),
      queryFn: async ({ pageParam = 0 }) => {
        if (!client) throw new Error("MCP client is not available");
        const result = (await client.callTool({
          name: "COLLECTION_THREAD_MESSAGES_LIST",
          arguments: {
            thread_id: thread.id,
            limit: MESSAGES_PAGE_SIZE,
            offset: pageParam,
          },
        })) as { structuredContent?: unknown };
        return (result.structuredContent ?? result) as {
          items: ThreadMessageEntity[];
          totalCount: number;
          hasMore: boolean;
        };
      },
      initialPageParam: 0 as number,
      getNextPageParam: (lastPage, allPages) => {
        const page = lastPage as { items?: ThreadMessageEntity[] } | undefined;
        const pages = allPages as Array<{ items?: ThreadMessageEntity[] }>;
        if ((page?.items?.length ?? 0) < MESSAGES_PAGE_SIZE) return undefined;
        return pages.length * MESSAGES_PAGE_SIZE;
      },
      staleTime: 60_000,
    });

  const allItems = data.pages.flatMap(
    (p: { items?: ThreadMessageEntity[] }) => p.items ?? [],
  );
  const rawMessages = allItems as unknown as ChatMessage[];
  const messages = rawMessages.filter(
    (m) => m.role === "user" || m.role === "assistant",
  );
  const messagePairs = useMessagePairs(messages);

  const lastMsgRef = useInfiniteScroll(
    () => {
      if (hasNextPage && !isFetchingNextPage) fetchNextPage();
    },
    hasNextPage ?? false,
    isFetchingNextPage,
  );

  return (
    <>
      <ThreadSheetHeader
        thread={thread}
        connections={connections}
        virtualMcps={virtualMcps}
        selectedIndex={selectedIndex}
        total={total}
        onPrev={onPrev}
        onNext={onNext}
      />
      <ThreadMetaRow
        thread={thread}
        connections={connections}
        virtualMcps={virtualMcps}
        members={members}
      />

      {messages.length === 0 ? (
        <ThreadConversationPanelEmpty />
      ) : (
        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="flex flex-col min-w-0 max-w-2xl mx-auto w-full">
            {messagePairs.map((pair, idx) => (
              <div
                key={`pair-${pair.user?.id ?? pair.assistant?.id}`}
                ref={
                  idx === messagePairs.length - 1
                    ? (lastMsgRef as (node: HTMLDivElement | null) => void)
                    : undefined
                }
              >
                <MessagePair
                  pair={pair}
                  isLastPair={idx === messagePairs.length - 1}
                  status="ready"
                />
              </div>
            ))}
            {isFetchingNextPage && <ThreadConversationPanelLoading />}
          </div>
        </div>
      )}
    </>
  );
}

// ── Thread sheet wrapper (renders header once, body swaps for loading/error) ─

function ThreadSheetBodyError() {
  const t = useT();
  return (
    <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
      {t("orgs.threads.failedToLoadMessages")}
    </div>
  );
}

function ThreadSheetBodyLoading() {
  const t = useT();
  return (
    <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
      {t("orgs.threads.loadingConversation")}
    </div>
  );
}

export function ThreadSheetBody({
  thread,
  client,
  locator,
  connections,
  virtualMcps,
  members,
  selectedIndex,
  total,
  onPrev,
  onNext,
}: {
  thread: ThreadEntity;
  client: ReturnType<typeof useMCPClient>;
  locator: string;
  connections: ReturnType<typeof useConnections>;
  virtualMcps: ReturnType<typeof useVirtualMCPs>;
  members: ReturnType<typeof useMembers>["data"] | undefined;
  selectedIndex: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <ErrorBoundary
      fallback={
        <>
          <ThreadSheetHeader
            thread={thread}
            connections={connections}
            virtualMcps={virtualMcps}
            selectedIndex={selectedIndex}
            total={total}
            onPrev={onPrev}
            onNext={onNext}
          />
          <ThreadSheetBodyError />
        </>
      }
    >
      <Suspense
        fallback={
          <>
            <ThreadSheetHeader
              thread={thread}
              connections={connections}
              virtualMcps={virtualMcps}
              selectedIndex={selectedIndex}
              total={total}
              onPrev={onPrev}
              onNext={onNext}
            />
            <ThreadSheetBodyLoading />
          </>
        }
      >
        <ThreadConversationPanel
          client={client}
          locator={locator}
          thread={thread}
          connections={connections}
          virtualMcps={virtualMcps}
          members={members}
          selectedIndex={selectedIndex}
          total={total}
          onPrev={onPrev}
          onNext={onNext}
        />
      </Suspense>
    </ErrorBoundary>
  );
}

// ── Main threads tab ────────────────────────────────────────────────────────

function ThreadsTabLoadingState() {
  const t = useT();
  return (
    <div className="flex flex-1 items-center justify-center py-20">
      <span className="text-sm text-muted-foreground">
        {t("orgs.threads.loading")}
      </span>
    </div>
  );
}

function ThreadsTabEmptyState({
  hasActiveFilters,
  t,
}: {
  hasActiveFilters: boolean;
  t: TFunction;
}) {
  return (
    <div className="flex flex-1 items-center justify-center py-20">
      <EmptyState
        title={t(
          hasActiveFilters
            ? "orgs.threads.noMatchingChats"
            : "orgs.threads.noChatsInTimeRange",
        )}
        description={t(
          hasActiveFilters
            ? "orgs.threads.tryAdjustingFilters"
            : "orgs.threads.tryExpandingTimeRange",
        )}
      />
    </div>
  );
}

function ThreadsTabLoadingMore() {
  const t = useT();
  return (
    <div className="py-4 text-center text-sm text-muted-foreground">
      {t("orgs.threads.loadingMore")}
    </div>
  );
}

export interface ThreadsTabContentProps {
  client: ReturnType<typeof useMCPClient>;
  locator: string;
  membersData: ReturnType<typeof useMembers>["data"] | undefined;
  allConnections: ReturnType<typeof useConnections>;
  allVirtualMcps: ReturnType<typeof useVirtualMCPs>;
  dateRange: { startDate: Date; endDate: Date };
  searchQuery: string;
  filterAgentIds?: string[];
  filterUserIds?: string[];
  filterStatus?: string;
}

const THREADS_PAGE_SIZE = 50;

export function ThreadsTabContent({
  client,
  locator,
  membersData,
  allConnections,
  allVirtualMcps,
  dateRange,
  searchQuery,
  filterAgentIds,
  filterUserIds,
  filterStatus,
}: ThreadsTabContentProps) {
  const t = useT();
  const [selectedThreadIndex, setSelectedThreadIndex] = useState<number | null>(
    null,
  );

  const startDate = dateRange.startDate.toISOString();
  const endDate = dateRange.endDate.toISOString();

  const filterKey = JSON.stringify({
    startDate,
    endDate,
    search: searchQuery,
    agentIds: filterAgentIds,
    userIds: filterUserIds,
    status: filterStatus,
  });

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
    useInfiniteQuery({
      queryKey: KEYS.threadsInfinite(locator, filterKey),
      queryFn: async ({ pageParam = 0 }) => {
        if (!client) throw new Error("MCP client is not available");
        const result = (await client.callTool({
          name: "COLLECTION_THREADS_LIST",
          arguments: {
            limit: THREADS_PAGE_SIZE,
            offset: pageParam,
            startDate,
            endDate,
            ...(searchQuery ? { search: searchQuery } : {}),
            ...(filterAgentIds && filterAgentIds.length > 0
              ? { agentId: filterAgentIds[0] }
              : {}),
            ...(filterUserIds && filterUserIds.length > 0
              ? { userId: filterUserIds[0] }
              : {}),
            ...(filterStatus && filterStatus !== "all"
              ? { status: filterStatus }
              : {}),
          },
        })) as { structuredContent?: unknown };
        return (result.structuredContent ?? result) as {
          items: ThreadEntity[];
          totalCount: number;
          hasMore: boolean;
        };
      },
      initialPageParam: 0 as number,
      getNextPageParam: (lastPage, allPages) => {
        const page = lastPage as { items?: ThreadEntity[] } | undefined;
        const pages = allPages as Array<{ items?: ThreadEntity[] }>;
        if ((page?.items?.length ?? 0) < THREADS_PAGE_SIZE) return undefined;
        return pages.length * THREADS_PAGE_SIZE;
      },
      staleTime: 30_000,
    });

  const visibleThreads = (data?.pages ?? []).flatMap(
    (p: { items?: ThreadEntity[] }) => p.items ?? [],
  );

  // Fetch per-thread token/cost for the loaded threads (from llm_call logs).
  const threadIds = visibleThreads.map((t) => t.id);
  const { data: usageData } = useQuery({
    queryKey: KEYS.monitoringThreadUsage(
      locator,
      JSON.stringify({ ids: threadIds, startDate, endDate }),
    ),
    queryFn: async () => {
      if (!client) throw new Error("MCP client is not available");
      const result = (await client.callTool({
        name: "MONITORING_THREAD_USAGE",
        arguments: { threadIds, startDate, endDate },
      })) as { structuredContent?: unknown };
      return (result.structuredContent ?? result) as {
        items: Array<ThreadUsage & { threadId: string }>;
      };
    },
    enabled: !!client && threadIds.length > 0,
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

  // Client-side sort of the loaded threads by tokens/cost (null = server order).
  const [sortKey, setSortKey] = useState<ThreadSortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const toggleSort = (key: ThreadSortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const sortValue = (id: string) => {
    const u = usageMap.get(id);
    if (!u) return 0;
    return sortKey === "cost" ? u.costUsd : u.totalTokens;
  };

  const displayThreads = sortKey
    ? [...visibleThreads].sort((a, b) => {
        const av = sortValue(a.id);
        const bv = sortValue(b.id);
        return sortDir === "desc" ? bv - av : av - bv;
      })
    : visibleThreads;

  const selectedThread =
    selectedThreadIndex !== null
      ? (displayThreads[selectedThreadIndex] ?? null)
      : null;

  const handleLoadMore = () => {
    if (hasNextPage && !isFetchingNextPage) fetchNextPage();
  };

  const lastRowRef = useInfiniteScroll(
    handleLoadMore,
    hasNextPage ?? false,
    isFetchingNextPage,
  );

  const hasActiveFilters =
    !!searchQuery ||
    (filterAgentIds?.length ?? 0) > 0 ||
    (filterUserIds?.length ?? 0) > 0 ||
    !!(filterStatus && filterStatus !== "all");

  const handlePrev = () =>
    setSelectedThreadIndex((i) => (i !== null && i > 0 ? i - 1 : i));
  const handleNext = () =>
    setSelectedThreadIndex((i) =>
      i !== null && i < displayThreads.length - 1 ? i + 1 : i,
    );

  return (
    <div className="flex-1 flex flex-col overflow-auto min-w-0">
      <div className="mx-auto w-full max-w-[1200px] px-4 md:px-10 flex flex-col flex-1 min-h-0">
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 min-w-0 pt-1">
            <div className="min-w-0">
              {isLoading ? (
                <ThreadsTabLoadingState />
              ) : visibleThreads.length === 0 ? (
                <ThreadsTabEmptyState
                  hasActiveFilters={hasActiveFilters}
                  t={t}
                />
              ) : (
                <>
                  <Table className="w-full border-collapse">
                    <TableHeader className="border-b-0 z-20">
                      <TableRow className="h-9 hover:bg-transparent border-b border-border">
                        <TableHead className="pl-4 text-xs font-mono font-normal text-muted-foreground uppercase tracking-wide">
                          {t("orgs.threads.title")}
                        </TableHead>
                        <TableHead className="w-36 px-3 text-xs font-mono font-normal text-muted-foreground uppercase tracking-wide">
                          {t("orgs.threads.agent")}
                        </TableHead>
                        <TableHead className="w-28 px-3 text-xs font-mono font-normal text-muted-foreground uppercase tracking-wide">
                          {t("orgs.threads.user")}
                        </TableHead>
                        <TableHead className="w-24 px-3 text-xs font-mono font-normal text-muted-foreground uppercase tracking-wide">
                          {t("orgs.threads.status")}
                        </TableHead>
                        <TableHead className="w-24 px-3 text-xs font-mono font-normal text-muted-foreground uppercase tracking-wide text-right">
                          <button
                            type="button"
                            onClick={() => toggleSort("tokens")}
                            className="inline-flex items-center gap-1 ml-auto hover:text-foreground transition-colors uppercase"
                          >
                            {t("orgs.threads.tokens")}
                            {sortKey === "tokens" &&
                              (sortDir === "desc" ? (
                                <ChevronDown size={12} />
                              ) : (
                                <ChevronUp size={12} />
                              ))}
                          </button>
                        </TableHead>
                        <TableHead className="w-24 px-3 text-xs font-mono font-normal text-muted-foreground uppercase tracking-wide text-right">
                          <button
                            type="button"
                            onClick={() => toggleSort("cost")}
                            className="inline-flex items-center gap-1 ml-auto hover:text-foreground transition-colors uppercase"
                          >
                            {t("orgs.threads.cost")}
                            {sortKey === "cost" &&
                              (sortDir === "desc" ? (
                                <ChevronDown size={12} />
                              ) : (
                                <ChevronUp size={12} />
                              ))}
                          </button>
                        </TableHead>
                        <TableHead className="w-32 px-3 pr-5 text-xs font-mono font-normal text-muted-foreground uppercase tracking-wide">
                          {t("orgs.threads.date")}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {displayThreads.map((thread, idx) => (
                        <ThreadRow
                          key={thread.id}
                          thread={thread}
                          usage={usageMap.get(thread.id)}
                          members={membersData}
                          connections={allConnections}
                          virtualMcps={allVirtualMcps}
                          onClick={() => setSelectedThreadIndex(idx)}
                          lastRowRef={
                            idx === displayThreads.length - 1
                              ? (lastRowRef as (
                                  node: HTMLTableRowElement | null,
                                ) => void)
                              : undefined
                          }
                        />
                      ))}
                    </TableBody>
                  </Table>
                  {isFetchingNextPage && <ThreadsTabLoadingMore />}
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      <Sheet
        open={selectedThreadIndex !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedThreadIndex(null);
        }}
      >
        <SheetContent className="sm:max-w-2xl flex flex-col p-0 gap-0">
          {selectedThread && selectedThreadIndex !== null && (
            <ThreadSheetBody
              thread={selectedThread}
              client={client}
              locator={locator}
              connections={allConnections}
              virtualMcps={allVirtualMcps}
              members={membersData}
              selectedIndex={selectedThreadIndex}
              total={displayThreads.length}
              onPrev={handlePrev}
              onNext={handleNext}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
