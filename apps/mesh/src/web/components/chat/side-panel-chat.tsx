import { cn } from "@deco/ui/lib/utils.ts";
import { useProjectContext } from "@decocms/mesh-sdk";
import { Suspense, useState } from "react";
import { ErrorBoundary } from "../error-boundary";

import { Chat } from "./index";
import { useChatStream } from "./context";
import { ChatContextPanel } from "./context-panel";
import { CenteredComposer } from "./centered-composer";
import { ThreadFilesPanel } from "./thread-files-panel";
import { wasCreditsEmptyDismissed } from "./credits-empty-state";

import { hasLocalCliHarness } from "@/web/lib/agent-capabilities";
import { useAiProviderKeys } from "@/web/hooks/collections/use-ai-providers";
import { useCurrentLink } from "@/web/hooks/use-current-link";
import { useDecoCredits } from "@/web/hooks/use-deco-credits";

// ---------- Panel content ----------

function ChatPanelContent() {
  const { org } = useProjectContext();
  const allKeys = useAiProviderKeys();
  const { isChatEmpty } = useChatStream();
  const [activePanel, setActivePanel] = useState<"chat" | "context">("chat");
  const deco = useDecoCredits();
  const link = useCurrentLink();

  // No cloud provider key needed when an online desktop CLI harness
  // (Claude Code / Codex) can back the chat instead.
  const showProviderEmptyState =
    allKeys.length === 0 && !hasLocalCliHarness(link);

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
        className={cn(
          "absolute inset-0 flex flex-col transition-opacity duration-100 ease-out",
          activePanel !== "chat"
            ? "opacity-0 pointer-events-none"
            : "opacity-100",
        )}
      >
        {isChatEmpty ? (
          <Chat.Main>
            <CenteredComposer
              onOpenContextPanel={() => setActivePanel("context")}
            />
          </Chat.Main>
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
