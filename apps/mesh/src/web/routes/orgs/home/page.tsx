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
import { AgentAvatar } from "@/web/components/agent-icon";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { ImportFromDecoDialog } from "@/web/components/import-from-deco-dialog.tsx";
import { Page } from "@/web/components/page";
import { authClient } from "@/web/lib/auth-client";
import { Button } from "@deco/ui/components/button.tsx";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@deco/ui/components/resizable.tsx";
import { Drawer, DrawerContent } from "@deco/ui/components/drawer.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  getWellKnownDecopilotVirtualMCP,
  useIsOrgAdmin,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import {
  ArrowRight,
  CheckDone01,
  LayoutRight,
  MessageChatSquare,
  Plus,
} from "@untitledui/icons";
import { useQuery } from "@tanstack/react-query";
import { Suspense, useState } from "react";

// ---------- Import deco.cx Banner ----------

const DECO_BANNER_GRADIENT = `url("data:image/svg+xml;utf8,<svg viewBox='0 0 500 64' xmlns='http://www.w3.org/2000/svg' preserveAspectRatio='none'><rect x='0' y='0' height='100%' width='100%' fill='url(%23grad)' opacity='0.6'/><defs><radialGradient id='grad' gradientUnits='userSpaceOnUse' cx='0' cy='0' r='10' gradientTransform='matrix(55.083 -7.55 1.4151 14.867 -37.917 86)'><stop stop-color='rgba(165,149,255,1)' offset='0.0045422'/><stop stop-color='rgba(210,202,255,1)' offset='0.16426'/><stop stop-color='rgba(255,255,255,1)' offset='0.32398'/><stop stop-color='rgba(255,255,255,0.3)' offset='0.68776'/><stop stop-color='rgba(255,224,139,0.3)' offset='0.74761'/><stop stop-color='rgba(255,209,80,0.3)' offset='0.77753'/><stop stop-color='rgba(255,193,22,0.3)' offset='0.80745'/><stop stop-color='rgba(208,236,26,1)' offset='0.96307'/></radialGradient></defs></svg>")`;
const DECO_BANNER_TEXTURE = "/decotexture.svg";

function ImportDecoSiteBanner({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full relative flex items-center gap-4 px-4 py-4 rounded-lg border border-border bg-background overflow-hidden transition-colors text-left cursor-pointer group"
      style={{
        backgroundImage: DECO_BANNER_GRADIENT,
        backgroundSize: "100% 100%",
      }}
    >
      <div className="relative shrink-0 p-1.5 bg-[var(--brand-green-light)] rounded-lg border border-border">
        <IntegrationIcon
          icon="/logos/deco%20logo.svg"
          name="deco.cx"
          size="xs"
          className="border-0 rounded-none"
        />
      </div>
      <p className="flex-1 relative text-sm font-medium text-foreground leading-none whitespace-nowrap">
        Import your deco.cx site
      </p>
      {/* Texture overlay — clipped by overflow-hidden on the button */}
      <img
        src={DECO_BANNER_TEXTURE}
        alt=""
        aria-hidden
        className="absolute pointer-events-none"
        style={{
          width: "274.5px",
          height: "272.25px",
          left: "calc(50% + 145.5px)",
          top: "calc(50% + 40px)",
          transform: "translate(-50%, -50%)",
        }}
      />
      <div className="relative bg-background flex items-center justify-center size-8 rounded-md shrink-0">
        <ArrowRight
          size={16}
          className="text-foreground transition-transform group-hover:translate-x-0.5"
        />
      </div>
    </button>
  );
}

function useIsDecoUser() {
  const { data: session } = authClient.useSession();
  const { data } = useQuery({
    queryKey: ["deco-profile", session?.user?.email],
    queryFn: async () => {
      const res = await fetch("/api/deco-sites/profile");
      if (!res.ok) return { isDecoUser: false };
      return res.json() as Promise<{ isDecoUser: boolean }>;
    },
    enabled: Boolean(session?.user?.email),
    staleTime: 5 * 60_000,
  });
  return data?.isDecoUser ?? false;
}

// ---------- Main Content ----------

function HomeChatContent({
  showContext,
  setShowContext,
}: {
  showContext: boolean;
  setShowContext: (v: boolean | ((prev: boolean) => boolean)) => void;
}) {
  const { org } = useProjectContext();
  const isOrgAdmin = useIsOrgAdmin();
  const { data: session } = authClient.useSession();
  const {
    isChatEmpty,
    activeTaskId,
    tasks,
    selectedVirtualMcp,
    createTask,
    switchToTask,
  } = useChat();
  const activeTask = tasks.find((task) => task.id === activeTaskId);
  const isMobileInner = useIsMobile();
  const [showTasks, setShowTasks] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const isDecoUser = useIsDecoUser();

  const userName = session?.user?.name?.split(" ")[0] || "there";

  const defaultAgent = getWellKnownDecopilotVirtualMCP(org.id);
  const displayAgent = selectedVirtualMcp ?? defaultAgent;

  return (
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
          {isMobileInner && (
            <>
              <button
                type="button"
                onClick={() => createTask()}
                disabled={isChatEmpty}
                className="flex size-7 items-center justify-center rounded-md hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                title="New chat"
              >
                <Plus size={16} className="text-muted-foreground" />
              </button>
              <button
                type="button"
                onClick={() => setShowTasks(true)}
                className="flex size-7 items-center justify-center rounded-md hover:bg-accent transition-colors"
                title="Tasks"
              >
                <CheckDone01 size={16} className="text-muted-foreground" />
              </button>
            </>
          )}
          {!isChatEmpty && !isMobileInner && (
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

      {/* Mobile: Tasks Drawer */}
      {isMobileInner && (
        <Drawer open={showTasks} onOpenChange={setShowTasks} direction="bottom">
          <DrawerContent className="h-[90vh] max-h-[90vh]">
            <div className="flex-1 overflow-hidden">
              <TasksPanel
                onTaskSelect={async (taskId) => {
                  await switchToTask(taskId);
                  setShowTasks(false);
                }}
              />
            </div>
          </DrawerContent>
        </Drawer>
      )}

      {!isChatEmpty ? (
        <>
          <Chat.Main>
            <Chat.Messages />
          </Chat.Main>
          <Chat.Footer>
            <Chat.Input onOpenContextPanel={() => setShowContext(true)} />
          </Chat.Footer>
        </>
      ) : isMobileInner ? (
        /* Mobile: greeting centered top, input + agents pinned to bottom */
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex-1 flex flex-col items-center justify-center px-4">
            <div className="flex flex-col items-center w-full max-w-[600px]">
              <div className="flex justify-center mb-4">
                <AgentAvatar
                  icon={displayAgent.icon}
                  name={displayAgent.title}
                  size="md"
                  className={cn(
                    "transition-opacity duration-200",
                    !selectedVirtualMcp && "invisible",
                  )}
                />
              </div>
              <div className="text-center">
                <p className="text-xl font-medium text-foreground">
                  What's on your mind, {userName}?
                </p>
              </div>
            </div>
          </div>
          <div className="shrink-0 flex flex-col items-center w-full gap-3 pb-2">
            <div className="flex flex-col items-center w-full max-w-2xl mx-auto gap-4 px-4">
              <Chat.IceBreakers className="w-full" />
              {isOrgAdmin && (
                <div className="flex flex-col items-center w-full">
                  <AgentsList />
                </div>
              )}
              {isDecoUser && isOrgAdmin && (
                <div className="w-full max-w-[500px] mx-auto">
                  <ImportDecoSiteBanner onClick={() => setImportOpen(true)} />
                </div>
              )}
            </div>
            <Chat.Footer>
              <Chat.Input />
            </Chat.Footer>
          </div>
        </div>
      ) : (
        /* Desktop: centered content + banner pinned to bottom */
        <div className="flex-1 flex flex-col items-center px-10">
          <div className="flex-1 flex flex-col items-center justify-center w-full">
            <div className="flex flex-col items-center w-full max-w-[600px]">
              <div className="flex justify-center mb-4">
                <AgentAvatar
                  icon={displayAgent.icon}
                  name={displayAgent.title}
                  size="md"
                  className={cn(
                    "transition-opacity duration-200",
                    !selectedVirtualMcp && "invisible",
                  )}
                />
              </div>
              <div className="text-center mb-6">
                <p className="text-xl font-medium text-foreground">
                  What's on your mind, {userName}?
                </p>
              </div>
              <Chat.IceBreakers className="w-full" />
              <div className="w-full">
                <Chat.Input onOpenContextPanel={() => setShowContext(true)} />
              </div>
            </div>
            {isOrgAdmin && (
              <div className="w-full max-w-[800px] mt-10 mx-auto">
                <AgentsList />
              </div>
            )}
          </div>
          {isDecoUser && isOrgAdmin && (
            <div className="w-full max-w-[500px] mx-auto pb-6">
              <ImportDecoSiteBanner onClick={() => setImportOpen(true)} />
            </div>
          )}
        </div>
      )}
      <ImportFromDecoDialog open={importOpen} onOpenChange={setImportOpen} />
    </Chat>
  );
}

function HomeContent() {
  const { allModelsConnections } = useChat();
  const isMobile = useIsMobile();
  const [showContext, setShowContext] = useState(false);

  // Show empty state when no LLM binding is found — no tasks panel
  if (allModelsConnections.length === 0) {
    return (
      <div className="flex flex-col h-full bg-background items-center justify-center">
        <Chat.NoLlmBindingEmptyState />
      </div>
    );
  }

  // Mobile: single-column chat only
  if (isMobile) {
    return (
      <div className="size-full">
        <HomeChatContent
          showContext={showContext}
          setShowContext={setShowContext}
        />
      </div>
    );
  }

  // Desktop: 3-pane resizable layout
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
        <HomeChatContent
          showContext={showContext}
          setShowContext={setShowContext}
        />
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
