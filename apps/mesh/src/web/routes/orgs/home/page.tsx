/**
 * Organization Home Page
 *
 * Dashboard with greeting, agent selector, ice breakers, and chat input.
 * Supports graph view toggle in header.
 */

import { Chat, useChat } from "@/web/components/chat/index";
import { ChatContextPanel } from "@/web/components/chat/context-panel";
import { TasksPanel } from "@/web/components/chat/tasks-panel";
import { EditableTaskTitle } from "@/web/components/chat/editable-task-title";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { AgentsList } from "@/web/components/home/agents-list.tsx";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { Page } from "@/web/components/page";
import { authClient } from "@/web/lib/auth-client";
import { Button } from "@deco/ui/components/button.tsx";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@deco/ui/components/resizable.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { LayoutRight, MessageChatSquare, Users03 } from "@untitledui/icons";
import { Suspense, useState } from "react";

// ---------- Main Content ----------

function HomeContent() {
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const {
    allModelsConnections,
    isChatEmpty,
    activeTaskId,
    tasks,
    selectedVirtualMcp,
  } = useChat();
  const activeTask = tasks.find((task) => task.id === activeTaskId);
  const [showContext, setShowContext] = useState(false);

  const userName = session?.user?.name?.split(" ")[0] || "there";

  // Use Decopilot as default agent
  const defaultAgent = getWellKnownDecopilotVirtualMCP(org.id);
  const displayAgent = selectedVirtualMcp ?? defaultAgent;

  // Show empty state when no LLM binding is found — no tasks panel
  if (allModelsConnections.length === 0) {
    return (
      <div className="flex flex-col h-full bg-background items-center justify-center">
        <Chat.NoLlmBindingEmptyState />
      </div>
    );
  }

  return (
    <ResizablePanelGroup direction="horizontal" className="size-full">
      <ResizablePanel defaultSize={20} minSize={10} id="tasks" order={1}>
        <TasksPanel />
      </ResizablePanel>
      <ResizableHandle className="bg-border/30" />
      <ResizablePanel
        defaultSize={showContext ? 50 : 80}
        minSize={30}
        id="main"
        order={2}
      >
        <Chat className="h-full bg-background">
          <Page.Header className="flex-none z-10 bg-background">
            <Page.Header.Left className="gap-2">
              {activeTask?.title && (
                <EditableTaskTitle
                  taskId={activeTask.id}
                  text={activeTask.title}
                  className="text-sm font-medium text-foreground"
                />
              )}
            </Page.Header.Left>
            <Page.Header.Right className="gap-1">
              {!isChatEmpty && (
                <button
                  type="button"
                  onClick={() => setShowContext((v) => !v)}
                  className={cn(
                    "flex size-7 items-center justify-center rounded-md border border-input hover:bg-accent transition-colors",
                    showContext && "bg-accent",
                  )}
                  title="Toggle context panel"
                >
                  <LayoutRight size={14} className="text-muted-foreground" />
                </button>
              )}
            </Page.Header.Right>
          </Page.Header>

          {!isChatEmpty ? (
            <>
              <Chat.Main>
                <Chat.Messages />
              </Chat.Main>
              <Chat.Footer>
                <Chat.Input onOpenContextPanel={() => setShowContext(true)} />
              </Chat.Footer>
            </>
          ) : (
            <div className="flex-1 min-h-0 flex flex-col items-center justify-center px-10 pb-32 pt-10">
              <div className="flex flex-col items-center w-full max-w-[600px]">
                {/* Agent Image */}
                <div className="flex justify-center mb-4">
                  <IntegrationIcon
                    icon={displayAgent.icon}
                    name={displayAgent.title}
                    size="md"
                    fallbackIcon={<Users03 size={20} />}
                    className="size-12 rounded-xl border border-stone-200/60 shadow-sm aspect-square transition-opacity duration-200"
                  />
                </div>

                {/* Greeting */}
                <div className="text-center mb-8">
                  <p className="text-xl font-medium text-foreground">
                    What's on your mind, {userName}?
                  </p>
                </div>

                {/* Chat Input */}
                <div className="w-full">
                  <Chat.Input />
                </div>

                {/* Ice breakers for selected agent */}
                <Chat.IceBreakers className="w-full" />
              </div>

              {/* Agents List - Separate container to allow wider width */}
              <div className="flex flex-col items-center w-full mt-4">
                <AgentsList />
              </div>
            </div>
          )}
        </Chat>
      </ResizablePanel>
      {showContext && (
        <>
          <ResizableHandle className="bg-border/30" />
          <ResizablePanel defaultSize={30} minSize={15} id="context" order={3}>
            <ChatContextPanel onClose={() => setShowContext(false)} />
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}

/**
 * Error fallback for the home chat page
 * Displays a clean error state that allows retry without breaking navigation
 */
function HomeChatErrorFallback({
  error,
  onRetry,
}: {
  error: Error | null;
  onRetry: () => void;
}) {
  // Check if it's an auth-related error (401)
  const isAuthError =
    error?.message?.includes("401") ||
    error?.message?.toLowerCase().includes("unauthorized");

  return (
    <Chat>
      <Page.Header className="flex-none">
        <Page.Header.Left className="gap-2" />
        <Page.Header.Right className="gap-1" />
      </Page.Header>
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <div className="max-w-sm space-y-4">
          <div className="bg-destructive/10 p-3 rounded-full mx-auto w-fit">
            <MessageChatSquare className="h-6 w-6 text-destructive" />
          </div>
          <div className="space-y-2">
            <h3 className="text-lg font-medium">
              {isAuthError ? "Unable to load models" : "Something went wrong"}
            </h3>
            <p className="text-sm text-muted-foreground">
              {isAuthError
                ? "There was an authentication error while loading the models. This might be due to an expired session or invalid API key."
                : error?.message || "An unexpected error occurred"}
            </p>
          </div>
          <Button variant="outline" onClick={onRetry}>
            Try again
          </Button>
        </div>
      </div>
    </Chat>
  );
}

export default function OrgHomePage() {
  return (
    <ErrorBoundary
      fallback={({ error, resetError }) => (
        <HomeChatErrorFallback error={error} onRetry={resetError} />
      )}
    >
      <Suspense fallback={<Chat.Skeleton />}>
        <HomeContent />
      </Suspense>
    </ErrorBoundary>
  );
}
