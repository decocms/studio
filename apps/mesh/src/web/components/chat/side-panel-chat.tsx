import { IntegrationIcon } from "@/web/components/integration-icon";
import { authClient } from "@/web/lib/auth-client";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
  useVirtualMCP,
} from "@decocms/mesh-sdk";
import { Users03 } from "@untitledui/icons";
import { Suspense, useState } from "react";
import { ErrorBoundary } from "../error-boundary";

import { Chat } from "./index";
import { useChatStream, useChatPrefs, useChatTask } from "./context";
import { ChatContextPanel } from "./context-panel";
import { wasCreditsEmptyDismissed } from "./credits-empty-state";
import { BranchPicker } from "../thread/github/branch-picker.tsx";

import { useAiProviderKeys } from "@/web/hooks/collections/use-ai-providers";
import { useDecoCredits } from "@/web/hooks/use-deco-credits";

// ---------- Default sidebar empty state ----------

function SidebarEmptyState() {
  const { org } = useProjectContext();
  const { selectedVirtualMcp } = useChatPrefs();
  const { data: session } = authClient.useSession();
  const { currentBranch, setCurrentTaskBranch } = useChatTask();

  const defaultAgent = getWellKnownDecopilotVirtualMCP(org.id);
  const displayAgent = selectedVirtualMcp ?? defaultAgent;
  const fullVm = useVirtualMCP(displayAgent.id);

  const userId = session?.user?.id ?? "";
  const githubRepo = fullVm?.metadata?.githubRepo ?? null;
  const showBranchPicker = !!githubRepo?.connectionId && !!userId;

  return (
    <div className="h-full w-full flex flex-col items-center justify-center gap-6 px-4">
      <div className="flex flex-col items-center justify-center gap-2 md:gap-4 text-center">
        <IntegrationIcon
          icon={displayAgent.icon}
          name={displayAgent.title}
          size="lg"
          fallbackIcon={<Users03 size={32} />}
          className="size-10 min-w-10 md:size-[60px]! md:min-w-[60px] rounded-xl md:rounded-[18px]!"
        />
        <h3 className="text-base md:text-xl font-medium text-foreground">
          {displayAgent.title}
        </h3>
        <div className="text-muted-foreground text-center text-base max-w-md line-clamp-2">
          {displayAgent.description ??
            "Ask anything about configuring model providers or using MCP Mesh."}
        </div>
        {showBranchPicker && (
          <div className="mt-2">
            <BranchPicker
              orgId={org.id}
              orgSlug={org.slug}
              userId={userId}
              connectionId={githubRepo.connectionId!}
              owner={githubRepo.owner}
              repo={githubRepo.name}
              vmMap={fullVm?.metadata?.vmMap}
              value={currentBranch ?? undefined}
              onChange={setCurrentTaskBranch}
            />
          </div>
        )}
      </div>
      <div className="w-full max-w-3xl mx-auto">
        <Chat.IceBreakers />
      </div>
    </div>
  );
}

// ---------- Panel content ----------

function ChatPanelContent() {
  const { org } = useProjectContext();
  const allKeys = useAiProviderKeys();
  const { isChatEmpty } = useChatStream();
  const [activePanel, setActivePanel] = useState<"chat" | "context">("chat");
  const deco = useDecoCredits();

  if (allKeys.length === 0) {
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
        {!isChatEmpty ? (
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
        ) : (
          <>
            <Chat.Main>
              <SidebarEmptyState />
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
