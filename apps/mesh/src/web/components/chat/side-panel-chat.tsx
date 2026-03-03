import { IntegrationIcon } from "@/web/components/integration-icon";
import { Page } from "@/web/components/page";
import { useDecoChatOpen } from "@/web/hooks/use-deco-chat-open";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { ClockRewind, Plus, Users03, X } from "@untitledui/icons";
import { Suspense, useState, useTransition } from "react";
import { ErrorBoundary } from "../error-boundary";
import { Chat, useChat } from "./index";
import { ThreadsView } from "./threads-sidebar";
import { EditableThreadTitle } from "./editable-thread-title";

function ChatPanelContent() {
  const { org } = useProjectContext();
  const [, setOpen] = useDecoChatOpen();
  const {
    selectedVirtualMcp,
    modelsConnections,
    isChatEmpty,
    activeThreadId,
    createThread,
    switchToThread,
    threads,
  } = useChat();
  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  const [showThreadsOverlay, setShowThreadsOverlay] = useState(false);
  const [isPending, startTransition] = useTransition();

  // Use Decopilot as default agent
  const defaultAgent = getWellKnownDecopilotVirtualMCP(org.id);
  const displayAgent = selectedVirtualMcp ?? defaultAgent;

  const handleNewThread = () => {
    startTransition(() => {
      createThread();
    });
  };

  if (modelsConnections.length === 0) {
    const title = "No model provider connected";
    const description =
      "Connect to a model provider to unlock AI-powered features.";

    return (
      <Chat className="animate-in fade-in-0 duration-200">
        <Page.Header className="flex-none" hideChat>
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
              org={org}
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
          "absolute inset-0 flex flex-col transition-[opacity,transform] ease-[var(--ease-out-quart)]",
          showThreadsOverlay
            ? "duration-300 opacity-0 -translate-x-4 pointer-events-none"
            : isPending
              ? "duration-150 opacity-0 pointer-events-none"
              : "duration-300 opacity-100 translate-x-0",
        )}
      >
        <Page.Header className="flex-none" hideChat>
          <Page.Header.Left className="gap-2">
            {!isChatEmpty && activeThread?.title && (
              <EditableThreadTitle
                threadId={activeThread.id}
                text={activeThread.title}
                className="text-sm font-medium text-foreground"
              />
            )}
          </Page.Header.Left>
          <Page.Header.Right className="gap-1">
            <button
              type="button"
              onClick={handleNewThread}
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
              onClick={() => setShowThreadsOverlay(true)}
              className="flex size-6 items-center justify-center rounded-full p-1 hover:bg-transparent group cursor-pointer"
              title="Chat history"
            >
              <ClockRewind
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
          <Chat.Input />
        </Chat.Footer>
      </div>

      {/* Threads view */}
      <div
        className={cn(
          "absolute inset-0 flex flex-col transition-[opacity,transform] duration-300 ease-[var(--ease-out-quart)]",
          showThreadsOverlay
            ? "opacity-100 translate-x-0"
            : "opacity-0 translate-x-4 pointer-events-none",
        )}
      >
        <ThreadsView
          threads={threads}
          activeThreadId={activeThreadId}
          onThreadSelect={switchToThread}
          onClose={() => setShowThreadsOverlay(false)}
        />
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
