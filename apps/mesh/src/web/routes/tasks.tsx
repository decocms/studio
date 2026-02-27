import { CollectionDisplayButton } from "@/web/components/collections/collection-display-button.tsx";
import { CollectionSearch } from "@/web/components/collections/collection-search.tsx";
import { CollectionTableWrapper } from "@/web/components/collections/collection-table-wrapper.tsx";
import { type TableColumn } from "@/web/components/collections/collection-table.tsx";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { Page } from "@/web/components/page";
import { User } from "@/web/components/user/user.tsx";
import { useListState } from "@/web/hooks/use-list-state";
import { formatTimeAgo } from "@/web/lib/format-time";
import { KEYS } from "@/web/lib/query-keys";
import type { ThreadEntity } from "@/tools/thread/schema";
import type { CollectionListOutput } from "@decocms/bindings/collections";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
  type ThreadDisplayStatus,
} from "@decocms/mesh-sdk";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@deco/ui/components/breadcrumb.tsx";
import { Badge } from "@deco/ui/components/badge.tsx";
import {
  CheckDone01,
  Loading01,
  Check,
  AlertOctagon,
  AlertCircle,
  Clock,
} from "@untitledui/icons";
import { useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery, useQueryClient } from "@tanstack/react-query";
import { Suspense, useState } from "react";
import { useDecopilotEvents } from "@/web/hooks/use-decopilot-events";
import { useChatStable } from "../components/chat/context";

function TaskStatusBadge({
  status,
  stepCount,
}: {
  status: ThreadDisplayStatus;
  stepCount?: number;
}) {
  switch (status) {
    case "in_progress":
      return (
        <Badge variant="secondary" className="gap-1">
          <Loading01 size={11} className="animate-spin" />
          {stepCount ? `Running · step ${stepCount}` : "Running"}
        </Badge>
      );
    case "completed":
      return (
        <Badge variant="success" className="gap-1">
          <Check size={11} />
          Completed
        </Badge>
      );
    case "requires_action":
      return (
        <Badge
          variant="outline"
          className="gap-1 text-blue-600 border-blue-600/40"
        >
          <AlertCircle size={11} />
          Waiting for input
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive" className="gap-1">
          <AlertOctagon size={11} />
          Failed
        </Badge>
      );
    case "expired":
      return (
        <Badge
          variant="outline"
          className="gap-1 text-warning border-warning/40"
        >
          <Clock size={11} />
          Timed out
        </Badge>
      );
    default:
      return (
        <Badge variant="secondary" className="gap-1">
          {status}
        </Badge>
      );
  }
}

function TasksContent() {
  const { org, project, locator } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });
  const navigate = useNavigate();
  const { switchToThread } = useChatStable();
  const queryClient = useQueryClient();

  const [stepCounts, setStepCounts] = useState<Map<string, number>>(new Map());

  useDecopilotEvents({
    orgId: org.id,
    onStep: (event) => {
      setStepCounts((prev) => {
        const next = new Map(prev);
        next.set(event.subject, event.data.stepCount);
        return next;
      });
    },
    onThreadStatus: (event) => {
      queryClient.invalidateQueries({ queryKey: KEYS.taskThreads(locator) });
      if (event.data.status !== "in_progress") {
        setStepCounts((prev) => {
          const next = new Map(prev);
          next.delete(event.subject);
          return next;
        });
      }
    },
  });

  // useListState and ThreadEntity both use snake_case for audit fields
  const listState = useListState({
    namespace: org.slug,
    resource: "tasks",
    defaultSortKey: "updated_at",
    defaultViewMode: "table",
  });

  const { data } = useSuspenseQuery({
    queryKey: KEYS.taskThreads(locator),
    queryFn: async () => {
      if (!client) throw new Error("MCP client is not available");
      const result = (await client.callTool({
        name: "COLLECTION_THREADS_LIST",
        arguments: { limit: 100, offset: 0 },
      })) as { structuredContent?: unknown };
      const payload = (result.structuredContent ??
        result) as CollectionListOutput<ThreadEntity>;
      return payload.items ?? [];
    },
    staleTime: 30_000,
  });

  // 1. Filter hidden (defensive -- storage already filters WHERE hidden = false,
  //    but protects against optimistic cache updates from chat's hideThread)
  const visible = data.filter((t) => !t.hidden);

  // 2. Filter by search
  const searched = listState.searchTerm
    ? visible.filter((t) =>
        t.title.toLowerCase().includes(listState.searchTerm.toLowerCase()),
      )
    : visible;

  // 3. Sort by sortKey (ThreadEntity uses snake_case)
  const threads = [...searched].sort((a, b) => {
    const { sortKey, sortDirection } = listState;
    if (!sortKey || !sortDirection) return 0;
    const aVal = String((a as Record<string, unknown>)[sortKey] ?? "");
    const bVal = String((b as Record<string, unknown>)[sortKey] ?? "");
    const cmp = aVal.localeCompare(bVal);
    return sortDirection === "asc" ? cmp : -cmp;
  });

  const onRowClick = async (thread: ThreadEntity) => {
    await switchToThread(thread.id);
    navigate({
      to: "/$org/$project",
      params: { org: org.slug, project: project.slug },
    });
  };

  const columns: TableColumn<ThreadEntity>[] = [
    {
      id: "title",
      header: "Title",
      render: (thread) => (
        <span className="text-sm font-medium text-foreground truncate">
          {thread.title}
        </span>
      ),
      cellClassName: "flex-1 min-w-0",
      sortable: true,
    },
    {
      id: "status",
      header: "Status",
      render: (thread) => (
        <TaskStatusBadge
          status={thread.status ?? "completed"}
          stepCount={stepCounts.get(thread.id)}
        />
      ),
      cellClassName: "w-40 shrink-0",
      sortable: true,
    },
    {
      id: "created_by",
      header: "Created by",
      render: (thread) => <User id={thread.created_by} size="3xs" />,
      cellClassName: "w-32 shrink-0",
    },
    {
      id: "updated_at",
      header: "Updated",
      render: (thread) => (
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {thread.updated_at ? formatTimeAgo(new Date(thread.updated_at)) : "—"}
        </span>
      ),
      cellClassName: "max-w-24 w-24 shrink-0",
      sortable: true,
    },
  ];

  return (
    <Page>
      <Page.Header>
        <Page.Header.Left>
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>Tasks</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </Page.Header.Left>
        <Page.Header.Right>
          <CollectionDisplayButton
            viewMode={listState.viewMode}
            onViewModeChange={listState.setViewMode}
            sortKey={listState.sortKey}
            sortDirection={listState.sortDirection}
            onSort={listState.handleSort}
            sortOptions={[
              { id: "title", label: "Title" },
              { id: "status", label: "Status" },
              { id: "updated_at", label: "Updated" },
            ]}
          />
        </Page.Header.Right>
      </Page.Header>

      <CollectionSearch
        value={listState.search}
        onChange={listState.setSearch}
        placeholder="Search tasks..."
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            listState.setSearch("");
            (event.target as HTMLInputElement).blur();
          }
        }}
      />

      <Page.Content>
        <div className="h-full flex flex-col overflow-hidden">
          <CollectionTableWrapper
            columns={columns}
            data={threads}
            isLoading={false}
            sortKey={listState.sortKey}
            sortDirection={listState.sortDirection}
            onSort={listState.handleSort}
            onRowClick={onRowClick}
            emptyState={
              listState.search ? (
                <EmptyState
                  image={
                    <CheckDone01 size={36} className="text-muted-foreground" />
                  }
                  title="No tasks found"
                  description={`No tasks match "${listState.search}"`}
                />
              ) : (
                <EmptyState
                  image={
                    <div className="flex items-center justify-center w-16 h-16 rounded-full bg-muted">
                      <CheckDone01
                        size={32}
                        className="text-muted-foreground"
                      />
                    </div>
                  }
                  title="No tasks yet"
                  description="Tasks will appear here when agents start processing work."
                />
              )
            }
          />
        </div>
      </Page.Content>
    </Page>
  );
}

export default function TasksPage() {
  return (
    <ErrorBoundary>
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center">
            <Loading01
              size={32}
              className="animate-spin text-muted-foreground"
            />
          </div>
        }
      >
        <TasksContent />
      </Suspense>
    </ErrorBoundary>
  );
}
