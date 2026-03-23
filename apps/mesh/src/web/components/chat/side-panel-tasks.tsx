/**
 * Global Tasks Side Panel
 *
 * Mirrors the ChatPanel pattern — lives in the shell layout,
 * visible on every page. Selecting a task switches the chat
 * conversation and opens the chat panel.
 */

import { Page } from "@/web/components/page";
import { useDecoChatOpen } from "@/web/hooks/use-deco-chat-open";
import { useDecoTasksOpen } from "@/web/hooks/use-deco-tasks-open";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.js";
import { Button } from "@deco/ui/components/button.js";
import { Loading01, Plus, X } from "@untitledui/icons";
import { User as UserIcon, Users as UsersIcon } from "lucide-react";
import { Suspense, useTransition } from "react";
import { ErrorBoundary } from "../error-boundary";
import { Chat, useChat } from "./index";
import { useChatStable } from "./context";
import { TaskListContent } from "./tasks-panel";
import type { TaskOwnerFilter } from "./task";

function OwnerFilter() {
  const { ownerFilter, setOwnerFilter, isFilterChangePending } =
    useChatStable();

  const isFiltered = ownerFilter === "me";
  const Icon = isFilterChangePending
    ? Loading01
    : isFiltered
      ? UserIcon
      : UsersIcon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="size-7"
          title={isFiltered ? "My tasks" : "All tasks"}
          disabled={isFilterChangePending}
        >
          <Icon
            size={14}
            className={cn(
              isFilterChangePending
                ? "animate-spin text-muted-foreground"
                : isFiltered
                  ? "text-foreground"
                  : "text-muted-foreground",
            )}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={ownerFilter}
          onValueChange={(v) => setOwnerFilter(v as TaskOwnerFilter)}
        >
          <DropdownMenuRadioItem value="me">My tasks</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="everyone">
            All tasks
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TasksPanelContent() {
  const [, setTasksOpen] = useDecoTasksOpen();
  const [, setChatOpen] = useDecoChatOpen();
  const { createTask, switchToTask } = useChat();
  const [isPending, startTransition] = useTransition();

  const handleNewTask = () => {
    startTransition(() => {
      createTask();
    });
  };

  return (
    <div className="flex flex-col h-full">
      <Page.Header className="flex-none" hideSidebarTrigger>
        <Page.Header.Left className="gap-2">
          <span className="text-sm font-medium text-foreground">Tasks</span>
        </Page.Header.Left>
        <Page.Header.Right className="gap-1">
          <OwnerFilter />
          <button
            type="button"
            onClick={handleNewTask}
            disabled={isPending}
            className="flex size-10 md:size-6 items-center justify-center rounded-full p-1 outline-none focus-visible:ring-0 hover:bg-transparent group cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            title="New task"
          >
            <Plus
              size={16}
              className="text-muted-foreground group-hover:text-foreground transition-colors"
            />
          </button>
          <button
            type="button"
            onClick={() => setTasksOpen(false)}
            className="flex size-10 md:size-6 items-center justify-center rounded-full p-1 outline-none focus-visible:ring-0 hover:bg-transparent transition-colors group cursor-pointer"
            title="Close tasks"
          >
            <X
              size={16}
              className="text-muted-foreground group-hover:text-foreground transition-colors"
            />
          </button>
        </Page.Header.Right>
      </Page.Header>

      <TaskListContent
        onTaskSelect={(taskId) => {
          switchToTask(taskId);
          // Open chat panel so user sees the conversation
          setChatOpen(true);
        }}
      />
    </div>
  );
}

export function TasksSidePanel() {
  return (
    <ErrorBoundary fallback={<Chat.Skeleton />}>
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center">
            <Loading01
              size={16}
              className="animate-spin text-muted-foreground"
            />
          </div>
        }
      >
        <TasksPanelContent />
      </Suspense>
    </ErrorBoundary>
  );
}
