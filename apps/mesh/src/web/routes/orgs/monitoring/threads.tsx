/**
 * Threads Tab — thread list with conversation sheet.
 */

import { Suspense, useState } from "react";
import type { useConnections, useVirtualMCPs } from "@decocms/mesh-sdk";
import { useMCPClient } from "@decocms/mesh-sdk";
import {
  useInfiniteQuery,
  useSuspenseInfiniteQuery,
} from "@tanstack/react-query";
import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { Badge } from "@deco/ui/components/badge.tsx";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@deco/ui/components/sheet.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { MultiSelect } from "@deco/ui/components/multi-select.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@deco/ui/components/table.tsx";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import {
  ChevronUp,
  ChevronDown,
  FilterLines,
  Container,
} from "@untitledui/icons";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { ErrorBoundary } from "@/web/components/error-boundary";
import {
  MessagePair,
  useMessagePairs,
} from "@/web/components/chat/message/pair.tsx";
import type { ChatMessage } from "@/web/components/chat/types.ts";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { useInfiniteScroll } from "@/web/hooks/use-infinite-scroll.ts";
import type { useMembers } from "@/web/hooks/use-members";
import { KEYS } from "@/web/lib/query-keys";
import { STATUS_CONFIG } from "@/web/lib/task-status";
import type { Thread, ThreadMessage } from "@/storage/types.ts";
import {
  getOrgMembers,
  getThreadAgentId,
  resolveAgentIcon,
  resolveAgentName,
} from "./utils.ts";

// ── Thread types (pick only the fields we need from the server types) ───────

type ThreadEntity = Pick<
  Thread,
  | "id"
  | "title"
  | "status"
  | "created_by"
  | "created_at"
  | "updated_at"
  | "virtual_mcp_id"
  | "run_config"
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
            aria-label="Previous thread"
          >
            <ChevronUp size={14} />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={onNext}
            disabled={selectedIndex === total - 1}
            className="h-7 w-7 text-muted-foreground"
            aria-label="Next thread"
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
        <div className="text-xs text-muted-foreground mb-1">Status</div>
        <div className="flex items-center gap-1.5">
          <StatusIcon size={13} className={statusCfg.iconClassName} />
          <span className={cn("text-sm", statusCfg.labelColor)}>
            {statusCfg.label}
          </span>
        </div>
      </div>

      <div>
        <div className="text-xs text-muted-foreground mb-1">Date</div>
        <div className="text-sm text-foreground">{formattedDate}</div>
      </div>

      <div>
        <div className="text-xs text-muted-foreground mb-1">User</div>
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
          <div className="text-xs text-muted-foreground mb-1">Agent</div>
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
  members,
  connections,
  virtualMcps,
  onClick,
  lastRowRef,
}: {
  thread: ThreadEntity;
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
      <TableCell className="w-32 px-3 pr-5 text-muted-foreground">
        <div>{dateStr}</div>
        <div className="text-xs text-muted-foreground/60">{timeStr}</div>
      </TableCell>
    </TableRow>
  );
}

// ── Conversation panel ──────────────────────────────────────────────────────

const MESSAGES_PAGE_SIZE = 100;

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
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          No messages in this thread
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="flex flex-col min-w-0 max-w-2xl mx-auto w-full">
            {messagePairs.map((pair, idx) => (
              <div
                key={pair.user.id}
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
            {isFetchingNextPage && (
              <div className="py-4 text-center text-xs text-muted-foreground">
                Loading more\u2026
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// ── Thread sheet wrapper (renders header once, body swaps for loading/error) ─

function ThreadSheetBody({
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
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            Failed to load messages
          </div>
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
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              Loading conversation\u2026
            </div>
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

// ── Threads filters popover ─────────────────────────────────────────────────

interface ThreadsFiltersPopoverProps {
  filterAgentIds: string[];
  filterUserIds: string[];
  filterStatus: string;
  virtualMcpOptions: Array<{ value: string; label: string }>;
  memberOptions: Array<{ value: string; label: string }>;
  activeFiltersCount: number;
  onUpdateFilters: (updates: {
    filterAgentIds?: string[];
    filterUserIds?: string[];
    filterStatus?: string;
  }) => void;
}

export function ThreadsFiltersPopover({
  filterAgentIds,
  filterUserIds,
  filterStatus,
  virtualMcpOptions,
  memberOptions,
  activeFiltersCount,
  onUpdateFilters,
}: ThreadsFiltersPopoverProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="relative">
          <FilterLines size={16} />
          <span className="hidden sm:inline">Filters</span>
          {activeFiltersCount > 0 && (
            <>
              <Badge
                variant="default"
                className="sm:hidden absolute -top-1.5 -right-1.5 h-4 min-w-4 px-1 text-[10px] leading-none"
              >
                {activeFiltersCount}
              </Badge>
              <Badge
                variant="default"
                className="hidden sm:flex ml-1 h-5 w-5 rounded-full p-0 items-center justify-center text-xs"
              >
                {activeFiltersCount}
              </Badge>
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[280px]">
        <div className="space-y-4">
          <h4 className="font-medium text-sm">Filter Threads</h4>

          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                Agent
              </label>
              <MultiSelect
                options={virtualMcpOptions}
                defaultValue={filterAgentIds}
                onValueChange={(values) =>
                  onUpdateFilters({ filterAgentIds: values.slice(0, 1) })
                }
                placeholder="All agents"
                variant="secondary"
                className="w-full"
                maxCount={1}
              />
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                User
              </label>
              <MultiSelect
                options={memberOptions}
                defaultValue={filterUserIds}
                onValueChange={(values) =>
                  onUpdateFilters({ filterUserIds: values.slice(0, 1) })
                }
                placeholder="All users"
                variant="secondary"
                className="w-full"
                maxCount={1}
              />
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                Status
              </label>
              <Select
                value={filterStatus}
                onValueChange={(value) =>
                  onUpdateFilters({ filterStatus: value })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {activeFiltersCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => {
                onUpdateFilters({
                  filterAgentIds: [],
                  filterUserIds: [],
                  filterStatus: "all",
                });
                setOpen(false);
              }}
            >
              Clear all filters
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── Main threads tab ────────────────────────────────────────────────────────

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

  const selectedThread =
    selectedThreadIndex !== null
      ? (visibleThreads[selectedThreadIndex] ?? null)
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
    (filterStatus && filterStatus !== "all");

  const handlePrev = () =>
    setSelectedThreadIndex((i) => (i !== null && i > 0 ? i - 1 : i));
  const handleNext = () =>
    setSelectedThreadIndex((i) =>
      i !== null && i < visibleThreads.length - 1 ? i + 1 : i,
    );

  return (
    <div className="flex-1 flex flex-col overflow-auto min-w-0">
      <div className="mx-auto w-full max-w-[1200px] px-4 md:px-10 flex flex-col flex-1 min-h-0">
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          <div className="flex-1 overflow-auto min-w-0">
            <div className="min-w-0">
              {isLoading ? (
                <div className="flex flex-1 items-center justify-center py-20">
                  <span className="text-sm text-muted-foreground">
                    Loading\u2026
                  </span>
                </div>
              ) : visibleThreads.length === 0 ? (
                <div className="flex flex-1 items-center justify-center py-20">
                  <EmptyState
                    title={
                      hasActiveFilters
                        ? "No matching threads"
                        : "No threads in this time range"
                    }
                    description={
                      hasActiveFilters
                        ? "Try adjusting your filters or search query."
                        : "Try expanding the time range to see older threads."
                    }
                  />
                </div>
              ) : (
                <>
                  <Table className="w-full border-collapse">
                    <TableHeader className="border-b-0 z-20">
                      <TableRow className="h-9 hover:bg-transparent border-b border-border">
                        <TableHead className="pl-4 text-xs font-mono font-normal text-muted-foreground uppercase tracking-wide">
                          Title
                        </TableHead>
                        <TableHead className="w-36 px-3 text-xs font-mono font-normal text-muted-foreground uppercase tracking-wide">
                          Agent
                        </TableHead>
                        <TableHead className="w-28 px-3 text-xs font-mono font-normal text-muted-foreground uppercase tracking-wide">
                          User
                        </TableHead>
                        <TableHead className="w-24 px-3 text-xs font-mono font-normal text-muted-foreground uppercase tracking-wide">
                          Status
                        </TableHead>
                        <TableHead className="w-32 px-3 pr-5 text-xs font-mono font-normal text-muted-foreground uppercase tracking-wide">
                          Date
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleThreads.map((thread, idx) => (
                        <ThreadRow
                          key={thread.id}
                          thread={thread}
                          members={membersData}
                          connections={allConnections}
                          virtualMcps={allVirtualMcps}
                          onClick={() => setSelectedThreadIndex(idx)}
                          lastRowRef={
                            idx === visibleThreads.length - 1
                              ? (lastRowRef as (
                                  node: HTMLTableRowElement | null,
                                ) => void)
                              : undefined
                          }
                        />
                      ))}
                    </TableBody>
                  </Table>
                  {isFetchingNextPage && (
                    <div className="py-4 text-center text-sm text-muted-foreground">
                      Loading more...
                    </div>
                  )}
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
              total={visibleThreads.length}
              onPrev={handlePrev}
              onNext={handleNext}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
