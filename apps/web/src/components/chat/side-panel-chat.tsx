import { cn } from "@deco/ui/lib/utils.ts";
import { useProjectContext } from "@/sdk";
import { Suspense, useState } from "react";
import { ErrorBoundary } from "../error-boundary";

import { Chat } from "./index";
import { useChatStream } from "./context";
import { useIsDesktopApp } from "@/hooks/use-is-desktop-app";
import { useNeedsRuntimeSetup } from "./use-needs-runtime-setup";
import { ChatContextPanel } from "./context-panel";
import { AgentHome } from "./agent-home";
import { ThreadFilesPanel } from "./thread-files-panel";
import { wasCreditsEmptyDismissed } from "./credits-empty-state";

import { useDecoCredits } from "@/hooks/use-deco-credits";
import { usePanelActions } from "@/layouts/shell-layout";

// ---------- Panel content ----------

function ChatSidePanelContent() {
  const { org } = useProjectContext();
  const { isChatEmpty } = useChatStream();
  const { openTab } = usePanelActions();
  const [activePanel, setActivePanel] = useState<"chat" | "context">("chat");
  const deco = useDecoCredits();

  // Surface the runtime-setup UI when there's no way to run a chat. On web
  // that's no cloud AI provider AND no usable local runtime; on native it's
  // no resolved local coding agent. Each empty state offers the Claude Code /
  // Codex options as a one-click escape. Same signal gates the main-panel
  // view tabs.
  const showProviderEmptyState = useNeedsRuntimeSetup();
  const isDesktopApp = useIsDesktopApp();

  if (showProviderEmptyState) {
    return (
      <Chat className="animate-in fade-in-0 duration-200">
        <Chat.Main className="flex flex-col items-center">
          <Chat.EmptyState>
            {isDesktopApp ? (
              // Native never offers cloud providers — only the local agents.
              <Chat.NativeAgentEmptyState />
            ) : (
              <Chat.NoAiProviderEmptyState
                // Picking a local runtime is the same gesture as opening a new
                // chat with this agent: open its Overview alongside the composer.
                onLocalRuntimePicked={() => openTab("overview")}
              />
            )}
          </Chat.EmptyState>
        </Chat.Main>
      </Chat>
    );
  }

  // Org has a Deco key with $0 balance and no other providers — show modal once
  const showCreditsModal =
    deco.hasDecoKey &&
    deco.isZeroBalance &&
    deco.hasOnlyDecoProvider &&
    !deco.isLoading &&
    isChatEmpty &&
    !wasCreditsEmptyDismissed(org.id);

  return (
    <Chat className="relative overflow-hidden animate-in fade-in-0 duration-200">
      {/* One-time modal for new orgs with $0 credits */}
      {showCreditsModal && <Chat.CreditsEmptyState />}

      {/* Chat view */}
      <div
        inert={activePanel !== "chat" ? true : undefined}
        aria-hidden={activePanel !== "chat"}
        className={cn(
          "absolute inset-0 flex flex-col transition-opacity duration-100 ease-out",
          activePanel !== "chat"
            ? "opacity-0 pointer-events-none"
            : "opacity-100",
        )}
      >
        {isChatEmpty ? (
          <AgentHome onOpenContextPanel={() => setActivePanel("context")} />
        ) : (
          <>
            {/* @container: the files panel floats in the right gutter on
                wide chats and becomes an in-flow topbar (flex row above
                the scroller) when the gutter can't fit it */}
            <Chat.Main className="relative flex flex-col overflow-hidden @container">
              <ThreadFilesPanel />
              <div className="min-h-0 flex-1">
                <Chat.Messages />
              </div>
            </Chat.Main>
            <Chat.Footer>
              <Chat.Input
                onOpenContextPanel={() => setActivePanel("context")}
              />
            </Chat.Footer>
          </>
        )}
      </div>

      {/* Context view */}
      <div
        inert={activePanel !== "context" ? true : undefined}
        aria-hidden={activePanel !== "context"}
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

export function ChatSidePanel() {
  return (
    <ErrorBoundary fallback={<Chat.Skeleton />}>
      <Suspense fallback={<Chat.Skeleton />}>
        <ChatSidePanelContent />
      </Suspense>
    </ErrorBoundary>
  );
}
