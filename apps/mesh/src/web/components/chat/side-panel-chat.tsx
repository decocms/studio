import { cn } from "@deco/ui/lib/utils.ts";
import {
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
  useVirtualMCP,
} from "@decocms/mesh-sdk";
import { Suspense, useState } from "react";
import { ErrorBoundary } from "../error-boundary";

import { Chat } from "./index";
import { useChatStream, useChatPrefs } from "./context";
import { ChatContextPanel } from "./context-panel";
import { CenteredComposer } from "./centered-composer";
import { wasCreditsEmptyDismissed } from "./credits-empty-state";

import {
  agentHasClonableSource,
  hasLocalCliHarness,
} from "@/web/lib/agent-capabilities";
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
  const { selectedVirtualMcp } = useChatPrefs();
  const defaultAgent = getWellKnownDecopilotVirtualMCP(org.id);
  const displayAgent = selectedVirtualMcp ?? defaultAgent;
  const fullVm = useVirtualMCP(displayAgent.id);
  const link = useCurrentLink();

  // Clonable agents (Start Website + GitHub-imported) can route through
  // a desktop CLI harness when one is online, so the no-provider gate
  // only fires for them if neither a cloud provider nor a local CLI is
  // available.
  const isClonableAgent = agentHasClonableSource(fullVm?.metadata);
  const showProviderEmptyState =
    allKeys.length === 0 && !(isClonableAgent && hasLocalCliHarness(link));

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
            <Chat.Main>
              <Chat.Messages />
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
