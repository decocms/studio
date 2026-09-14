import { cn } from "@decocms/ui/lib/utils.ts";
import { useProjectContext } from "@/sdk";
import { useState } from "react";
import { ErrorBoundary } from "../error-boundary";
import { MainPanelBoundary } from "@/layouts/main-panel-boundary";
import { useT } from "@/i18n/use-t.ts";

import { Chat } from "./index";
import { useChatStream } from "./context";
import { useOptionalChatTask } from "./chat-context";
import { useSessionRuntime } from "@/hooks/use-session-runtime";
import { useNeedsRuntimeSetup } from "./use-needs-runtime-setup";
import { ChatContextPanel } from "./context-panel";
import { AgentHome } from "./agent-home";
import { ThreadFilesPanel } from "./thread-files-panel";
import { wasCreditsEmptyDismissed } from "./credits-empty-state";

import { useDecoCredits } from "@/hooks/use-deco-credits";

// ---------- Panel content ----------

function ChatSidePanelContent() {
  const { org } = useProjectContext();
  const taskCtx = useOptionalChatTask();
  const { isChatEmpty } = useChatStream();
  const [activePanel, setActivePanel] = useState<"chat" | "context">("chat");
  const deco = useDecoCredits();

  // The structured chat side panel is web-only. Native uses the terminal
  // runtime adapter instead, so cloud provider setup is the only gate here.
  const needsRuntimeSetup = useNeedsRuntimeSetup();
  const { runtime } = useSessionRuntime(taskCtx?.virtualMcpId);
  // A CMS session never talks to a model, so neither an unconfigured AI
  // provider nor the agent's icebreakers are ITS empty state. It has exactly
  // one: the "Start coding session" CTA the composer renders. Offering
  // "Create Agents" to a session that cannot run one is a dead end.
  // Existing history stays readable if the org later loses its provider;
  // setup replaces only the empty composer.
  const showProviderEmptyState =
    needsRuntimeSetup && runtime !== "cms" && isChatEmpty;

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
        {isChatEmpty && runtime !== "cms" ? (
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

/**
 * The chat panel belongs to the shell, but the conversation inside it is data
 * like any other, so it waits behind the app's one panel loader rather than a
 * skeleton of its own: the card frame stays, a spinner sits in it, and the
 * chat replaces the spinner. A skeleton was worse on both counts — it drew a
 * fake conversation that never matched the real one, and as the error fallback
 * it left that fake conversation on screen forever.
 */
export function ChatSidePanel() {
  const t = useT();
  return (
    <ErrorBoundary
      fallback={
        <div
          role="alert"
          className="flex h-full flex-1 items-center justify-center text-sm text-muted-foreground"
        >
          {t("agentShellLayout.agentShellLayout.chatLoadingError")}
        </div>
      }
    >
      <MainPanelBoundary>
        <ChatSidePanelContent />
      </MainPanelBoundary>
    </ErrorBoundary>
  );
}
