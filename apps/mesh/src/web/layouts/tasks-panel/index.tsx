/**
 * TasksPanel — left-panel entry point. Org-wide (not scoped to a virtualMCP).
 * Renders all open tasks in a single list, sorted by created_at.
 * Automation-triggered tasks are distinguished by a badge on their avatar.
 */

import { Suspense } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { ClipboardCheck } from "@untitledui/icons";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { Chat } from "@/web/components/chat";
import { EmptyState } from "@/web/components/empty-state";
import {
  useThreads,
  filterThreads,
  useThreadActions,
} from "@/web/components/chat/task";
import type { Task } from "@/web/components/chat/task/types";
import { usePanelActions } from "@/web/layouts/shell-layout";
import { authClient } from "@/web/lib/auth-client";
import { TasksSection } from "./tasks-section";

function TasksPanelContent() {
  const { data: session } = authClient.useSession();
  const currentUserId = session?.user?.id;
  const { threads, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useThreads("org", "open");
  const { hideThread } = useThreadActions();

  const myTasks = filterThreads(threads, {
    ownerUserId: currentUserId,
    hasTrigger: false,
  });
  const automationTasks = filterThreads(threads, { hasTrigger: true });

  const { setTaskId, createNewTask } = usePanelActions();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as {
    org?: string;
    taskId?: string;
  };

  const activeTaskId = params.taskId ?? null;

  const allTasks = [...myTasks, ...automationTasks].sort((a, b) =>
    (b.created_at ?? "").localeCompare(a.created_at ?? ""),
  );

  const handleArchive = (task: Task) => {
    const wasActive = task.id === activeTaskId;
    hideThread(task.id);

    if (!wasActive) return;

    // Active thread archived — redirect to the next open thread, or fall
    // back to the org home when no threads remain.
    const next = allTasks.find((t) => t.id !== task.id);
    if (next) {
      setTaskId(next.id, next.virtual_mcp_id);
    } else if (params.org) {
      navigate({
        to: "/$org",
        params: { org: params.org },
        search: { tasks: 0 },
      });
    }
  };

  if (allTasks.length === 0) {
    return (
      <div className="h-full flex items-center justify-center p-4">
        <EmptyState
          image={<ClipboardCheck size={48} className="text-muted-foreground" />}
          title="No tasks yet"
          description="Start a conversation to create your first task."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0 p-2 gap-3">
      <TasksSection
        title="Tasks"
        tasks={allTasks}
        activeTaskId={activeTaskId}
        onSelect={(t) => setTaskId(t.id, t.virtual_mcp_id)}
        onArchive={handleArchive}
        onNew={createNewTask}
        showNewButton
        currentUserId={currentUserId}
        hasMore={hasNextPage}
        isFetchingMore={isFetchingNextPage}
        onLoadMore={fetchNextPage}
      />
    </div>
  );
}

function TasksPanelSkeleton() {
  return (
    <div className="flex flex-col h-full p-2 gap-1.5">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-10 rounded-md bg-muted/60 animate-pulse" />
      ))}
    </div>
  );
}

export function TasksPanel() {
  return (
    <ErrorBoundary fallback={<Chat.Skeleton />}>
      <Suspense fallback={<TasksPanelSkeleton />}>
        <TasksPanelContent />
      </Suspense>
    </ErrorBoundary>
  );
}
