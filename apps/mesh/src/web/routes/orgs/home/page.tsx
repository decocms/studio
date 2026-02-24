/**
 * Organization Home Page
 *
 * Dashboard with greeting, agent selector, ice breakers, and chat input.
 * Supports graph view toggle in header.
 */

import { Chat, useChat } from "@/web/components/chat/index";
import { ThreadsSidebar } from "@/web/components/chat/threads-sidebar.tsx";
import { TypewriterTitle } from "@/web/components/chat/typewriter-title";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { AgentsList } from "@/web/components/home/agents-list.tsx";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { Page } from "@/web/components/page";
import { authClient } from "@/web/lib/auth-client";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import {
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
} from "@decocms/mesh-sdk";
import {
  ClockRewind,
  MessageChatSquare,
  Pin01,
  Plus,
  Share07,
  Users03,
} from "@untitledui/icons";
import { Suspense, useState } from "react";
import { toast } from "sonner";

/**
 * Get time-based greeting
 */
function getTimeBasedGreeting(): string {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return "Morning";
  if (hour >= 12 && hour < 17) return "Afternoon";
  if (hour >= 17 && hour < 22) return "Evening";
  return "Night";
}

// ---------- Main Content ----------

function HomeContent() {
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const {
    modelsConnections,
    isChatEmpty,
    activeThreadId,
    createThread,
    switchToThread,
    threads,
    selectedVirtualMcp,
  } = useChat();
  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  const [isThreadsSidebarOpen, setIsThreadsSidebarOpen] = useState(false);

  const userName = session?.user?.name?.split(" ")[0] || "there";
  const greeting = getTimeBasedGreeting();

  // Use Decopilot as default agent
  const defaultAgent = getWellKnownDecopilotVirtualMCP(org.id);
  const displayAgent = selectedVirtualMcp ?? defaultAgent;

  // Show empty state when no LLM binding is found
  if (modelsConnections.length === 0) {
    return (
      <div className="flex flex-col size-full bg-background items-center justify-center">
        <Chat.NoLlmBindingEmptyState org={org} />
      </div>
    );
  }

  return (
    <Chat>
      <Page.Header className="flex-none z-10 bg-background">
        <Page.Header.Left className="gap-2">
          {activeThread?.title && (
            <TypewriterTitle
              text={activeThread.title}
              className="text-sm font-medium text-foreground"
            />
          )}
        </Page.Header.Left>
        <Page.Header.Right className="gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-7 border border-input"
                onClick={() => createThread()}
                disabled={isChatEmpty}
                aria-label="New chat"
              >
                <Plus size={16} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New chat</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-7 border border-input"
                onClick={() => setIsThreadsSidebarOpen(true)}
                aria-label="Chat history"
              >
                <ClockRewind size={16} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Chat history</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-7 border border-input"
                onClick={() => {
                  // TODO: Implement thread pinning functionality
                  toast.info("Pin feature coming soon");
                }}
                disabled={isChatEmpty}
                aria-label="Pin chat"
              >
                <Pin01 size={16} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Pin chat</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-7 border border-input"
                onClick={() => {
                  // TODO: Implement share functionality
                  toast.info("Share feature coming soon");
                }}
                disabled={isChatEmpty}
                aria-label="Share chat"
              >
                <Share07 size={16} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Share chat</TooltipContent>
          </Tooltip>
        </Page.Header.Right>
      </Page.Header>

      {!isChatEmpty ? (
        <>
          <Chat.Main>
            <Chat.Messages />
          </Chat.Main>
          <Chat.Footer>
            <Chat.Input />
          </Chat.Footer>
        </>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center px-10 pb-32 pt-10">
          <div className="flex flex-col items-center gap-3 w-full max-w-[600px]">
            {/* Agent Image */}
            <div className="flex justify-center">
              <IntegrationIcon
                icon={displayAgent.icon}
                name={displayAgent.title}
                size="md"
                fallbackIcon={<Users03 size={20} />}
                className="size-12 rounded-xl border border-stone-200/60 shadow-sm aspect-square transition-opacity duration-200"
              />
            </div>

            {/* Greeting */}
            <div className="text-center">
              <p className="text-lg font-medium text-foreground">
                {greeting} {userName},
              </p>
              <p className="text-base text-muted-foreground opacity-50 mb-0">
                What are we building today?
              </p>
            </div>

            {/* Chat Input */}
            <div className="w-full -mt-1">
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

      {/* Threads Sidebar */}
      <ThreadsSidebar
        open={isThreadsSidebarOpen}
        onOpenChange={setIsThreadsSidebarOpen}
        threads={threads}
        activeThreadId={activeThreadId}
        onThreadSelect={async (threadId) => {
          await switchToThread(threadId);
          setIsThreadsSidebarOpen(false);
        }}
      />
    </Chat>
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
