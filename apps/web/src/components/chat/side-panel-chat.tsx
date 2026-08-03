import { cn } from "@deco/ui/lib/utils.ts";
import { useProjectContext } from "@/sdk";
import { Suspense, useState } from "react";
import { ErrorBoundary } from "../error-boundary";

import { Chat } from "./index";
import { useChatStream } from "./context";
import { useNeedsRuntimeSetup } from "./use-needs-runtime-setup";
import { ChatContextPanel } from "./context-panel";
import { AgentHome } from "./agent-home";
import { ThreadFilesPanel } from "./thread-files-panel";
import { wasCreditsEmptyDismissed } from "./credits-empty-state";

import { useDecoCredits } from "@/hooks/use-deco-credits";

// ---------- Panel content ----------

function ChatSidePanelContent() {
  const { org } = useProjectContext();
  const { isChatEmpty } = useChatStream();
  const [activePanel, setActivePanel] = useState<"chat" | "context">("chat");
  const deco = useDecoCredits();

  // The structured chat side panel is web-only. Native uses the terminal
  // runtime adapter instead, so cloud provider setup is the only gate here.
  const showProviderEmptyState = useNeedsRuntimeSetup();

  if (showProviderEmptyState) {
    return (
      <Chat className="animate-in fade-in-0 duration-200">
        <Chat.Main className="flex flex-col items-center">
          <Chat.EmptyState>
            <Chat.NoAiProviderEmptyState />
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
