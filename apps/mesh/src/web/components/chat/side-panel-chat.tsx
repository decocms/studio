import { IntegrationIcon } from "@/web/components/integration-icon";
import { Page } from "@/web/components/page";
import { useDecoChatOpen } from "@/web/hooks/use-deco-chat-open";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
} from "@decocms/mesh-sdk";
import {
  ChevronLeft,
  CheckDone01,
  Loading01,
  Plus,
  Users03,
  X,
} from "@untitledui/icons";
import { Suspense, useState, useTransition } from "react";
import { ErrorBoundary } from "../error-boundary";

import { Chat, useChat } from "./index";
import { ChatContextPanel } from "./context-panel";
import { TaskListContent } from "./tasks-panel";

import { EditableTaskTitle } from "./editable-task-title";
import { useAiProviders } from "@/web/hooks/collections/use-llm";

function ChatPanelContent() {
  const { org } = useProjectContext();
  const [, setOpen] = useDecoChatOpen();
  const aiProviders = useAiProviders();
  const {
    selectedVirtualMcp,
    isChatEmpty,
    activeTaskId,
    createTask,
    switchToTask,
    tasks,
  } = useChat();
  const activeTask = tasks.find((task) => task.id === activeTaskId);
  const [activePanel, setActivePanel] = useState<"chat" | "tasks" | "context">(
    "chat",
  );
  const [isPending, startTransition] = useTransition();

  // Use Decopilot as default agent
  const defaultAgent = getWellKnownDecopilotVirtualMCP(org.id);
  const displayAgent = selectedVirtualMcp ?? defaultAgent;

  const handleNewTask = () => {
    startTransition(() => {
      createTask();
    });
  };

  if (aiProviders?.providers?.length === 0) {
    const title = "No model provider connected";
    const description =
      "Connect to a model provider to unlock AI-powered features.";

    return (
      <Chat className="animate-in fade-in-0 duration-200">
        <Page.Header className="flex-none" hideSidebarTrigger>
          <Page.Header.Left className="gap-2" />
          <Page.Header.Right className="gap-1">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="flex size-6 items-center justify-center rounded-full p-1 hover:bg-transparent transition-colors group cursor-pointer"
              title="Close chat"
            >
              <X
                size={16}
                className="text-muted-foreground group-hover:text-foreground transition-colors"
              />
            </button>
          </Page.Header.Right>
        </Page.Header>

        <Chat.Main className="flex flex-col items-center">
          <Chat.EmptyState>
            <Chat.NoLlmBindingEmptyState
              title={title}
              description={description}
            />
          </Chat.EmptyState>
        </Chat.Main>
      </Chat>
    );
  }

  return (
    <Chat className="relative overflow-hidden animate-in fade-in-0 duration-200">
      {/* Chat view */}
      <div
        className={cn(
          "absolute inset-0 flex flex-col transition-opacity duration-100 ease-out",
          activePanel !== "chat" || isPending
            ? "opacity-0 pointer-events-none"
            : "opacity-100",
        )}
      >
        <Page.Header className="flex-none" hideSidebarTrigger>
          <Page.Header.Left className="gap-2">
            {!isChatEmpty && activeTask?.title && (
              <EditableTaskTitle
                taskId={activeTask.id}
                text={activeTask.title}
                className="text-sm font-medium text-foreground"
              />
            )}
          </Page.Header.Left>
          <Page.Header.Right className="gap-1">
            <button
              type="button"
              onClick={handleNewTask}
              disabled={isPending}
              className="flex size-6 items-center justify-center rounded-full p-1 hover:bg-transparent group cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              title="New chat"
            >
              <Plus
                size={16}
                className="text-muted-foreground group-hover:text-foreground transition-colors"
              />
            </button>
            <button
              type="button"
              onClick={() => setActivePanel("tasks")}
              className="flex size-6 items-center justify-center rounded-full p-1 hover:bg-transparent group cursor-pointer"
              title="Tasks"
            >
              <CheckDone01
                size={16}
                className="text-muted-foreground group-hover:text-foreground transition-colors"
              />
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="flex size-6 items-center justify-center rounded-full p-1 hover:bg-transparent transition-colors group cursor-pointer"
              title="Close chat"
            >
              <X
                size={16}
                className="text-muted-foreground group-hover:text-foreground transition-colors"
              />
            </button>
          </Page.Header.Right>
        </Page.Header>

        <Chat.Main>
          {isChatEmpty ? (
            <Chat.EmptyState>
              <div className="flex flex-col items-center gap-6 w-full px-4">
                <div className="flex flex-col items-center justify-center gap-4 p-0 text-center">
                  <IntegrationIcon
                    icon={displayAgent.icon}
                    name={displayAgent.title}
                    size="lg"
                    fallbackIcon={<Users03 size={32} />}
                    className="size-[60px]! rounded-[18px]!"
                  />
                  <h3 className="text-xl font-medium text-foreground">
                    {displayAgent.title}
                  </h3>
                  <div className="text-muted-foreground text-center text-sm max-w-md">
                    {displayAgent.description ??
                      "Ask anything about configuring model providers or using MCP Mesh."}
                  </div>
                </div>
                <Chat.IceBreakers />
              </div>
            </Chat.EmptyState>
          ) : (
            <Chat.Messages />
          )}
        </Chat.Main>

        <Chat.Footer>
          <Chat.Input onOpenContextPanel={() => setActivePanel("context")} />
        </Chat.Footer>
      </div>

      {/* Tasks view */}
      <div
        className={cn(
          "absolute inset-0 flex flex-col transition-opacity duration-100 ease-out",
          activePanel === "tasks"
            ? "opacity-100"
            : "opacity-0 pointer-events-none",
        )}
      >
        <Page.Header className="flex-none" hideSidebarTrigger>
          <Page.Header.Left className="gap-2">
            <span className="text-sm font-normal text-foreground">Tasks</span>
          </Page.Header.Left>
          <Page.Header.Right className="gap-1">
            <button
              type="button"
              onClick={() => setActivePanel("chat")}
              className="flex size-6 items-center justify-center rounded-full p-1 hover:bg-transparent transition-colors group cursor-pointer"
              title="Back to chat"
            >
              <ChevronLeft
                size={16}
                className="text-muted-foreground group-hover:text-foreground transition-colors"
              />
            </button>
          </Page.Header.Right>
        </Page.Header>
        <ErrorBoundary
          fallback={() => (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-xs text-muted-foreground">
                Unable to load tasks
              </p>
            </div>
          )}
        >
          <Suspense
            fallback={
              <div className="flex-1 flex items-center justify-center">
                <Loading01
                  size={16}
                  className="animate-spin text-muted-foreground"
                />
              </div>
            }
          >
            <TaskListContent
              onTaskSelect={async (taskId) => {
                await switchToTask(taskId);
                setActivePanel("chat");
              }}
            />
          </Suspense>
        </ErrorBoundary>
      </div>

      {/* Context view */}
      <div
        className={cn(
          "absolute inset-0 flex flex-col transition-opacity duration-100 ease-out",
          activePanel === "context"
            ? "opacity-100"
            : "opacity-0 pointer-events-none",
        )}
      >
        <ChatContextPanel back onClose={() => setActivePanel("chat")} />
      </div>
    </Chat>
  );
}

export function ChatPanel() {
  return (
    <ErrorBoundary fallback={<Chat.Skeleton />}>
      <Suspense fallback={<Chat.Skeleton />}>
        <ChatPanelContent />
      </Suspense>
    </ErrorBoundary>
  );
}
