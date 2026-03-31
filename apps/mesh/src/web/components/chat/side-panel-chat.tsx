import { AgentAvatar } from "@/web/components/agent-icon";
import { AgentsList } from "@/web/components/home/agents-list.tsx";
import { ImportFromDecoDialog } from "@/web/components/import-from-deco-dialog.tsx";
import { IntegrationIcon } from "@/web/components/integration-icon";
import { authClient } from "@/web/lib/auth-client";
import { KEYS } from "@/web/lib/query-keys";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { ArrowRight, Users03 } from "@untitledui/icons";
import { useQuery } from "@tanstack/react-query";
import { Suspense, useState } from "react";
import { ErrorBoundary } from "../error-boundary";

import { Chat } from "./index";
import { useChatStream, useChatPrefs } from "./context";
import { ChatContextPanel } from "./context-panel";

import { useAiProviderKeys } from "@/web/hooks/collections/use-ai-providers";

// ---------- Import deco.cx Banner ----------

const DECO_BANNER_GRADIENT = [
  "radial-gradient(ellipse 25% 220% at -5% 120%, rgba(165,149,255,0.35) 0%, transparent 100%)",
  "radial-gradient(ellipse 25% 220% at 105% -20%, rgba(208,236,26,0.32) 0%, transparent 100%)",
].join(", ");
const DECO_BANNER_TEXTURE = "/decotexture.svg";

function ImportDecoSiteBanner({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full relative flex items-center gap-4 px-4 py-4 rounded-lg border border-border bg-background overflow-hidden transition-colors text-left cursor-pointer group"
      style={{ backgroundImage: DECO_BANNER_GRADIENT }}
    >
      <div className="relative shrink-0 p-1.5 bg-[var(--brand-green-light)] rounded-lg border border-border">
        <IntegrationIcon
          icon="/logos/deco%20logo.svg"
          name="deco.cx"
          size="xs"
          className="border-0 rounded-none bg-transparent"
        />
      </div>
      <p className="flex-1 relative text-sm font-medium text-foreground leading-none whitespace-nowrap">
        Import your deco.cx site
      </p>
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
    queryKey: KEYS.decoProfile(session?.user?.email),
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

// ---------- Home empty state (greeting, agents, ice breakers, banner) ----------

function HomeEmptyState({
  onOpenContextPanel,
}: {
  onOpenContextPanel: () => void;
}) {
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const { selectedVirtualMcp } = useChatPrefs();
  const [importOpen, setImportOpen] = useState(false);
  const isDecoUser = useIsDecoUser();
  const isMobile = useIsMobile();

  const userName = session?.user?.name?.split(" ")[0] || "there";
  const defaultAgent = getWellKnownDecopilotVirtualMCP(org.id);
  const displayAgent = selectedVirtualMcp ?? defaultAgent;

  if (isMobile) {
    return (
      <>
        <div className="flex-1 flex flex-col items-center px-4">
          {/* Centered greeting */}
          <div className="flex-1 flex flex-col items-center justify-center w-full">
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
            <p className="text-xl font-medium text-foreground text-center">
              What's on your mind, {userName}?
            </p>
          </div>
          {/* Agents above prompts, input at bottom */}
          <div className="w-full flex flex-col gap-4 pb-4">
            <AgentsList />
            <Chat.IceBreakers className="w-full" />
            <Chat.Input onOpenContextPanel={onOpenContextPanel} />
            {isDecoUser && (
              <ImportDecoSiteBanner onClick={() => setImportOpen(true)} />
            )}
          </div>
        </div>
        <ImportFromDecoDialog open={importOpen} onOpenChange={setImportOpen} />
      </>
    );
  }

  return (
    <>
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
              <Chat.Input onOpenContextPanel={onOpenContextPanel} />
            </div>
          </div>
          <div className="w-full max-w-[800px] mt-10 mx-auto">
            <AgentsList />
          </div>
        </div>
        <div className="w-full max-w-[500px] mx-auto flex flex-col gap-2 pb-6">
          {isDecoUser && (
            <ImportDecoSiteBanner onClick={() => setImportOpen(true)} />
          )}
        </div>
      </div>
      <ImportFromDecoDialog open={importOpen} onOpenChange={setImportOpen} />
    </>
  );
}

// ---------- Default sidebar empty state ----------

function SidebarEmptyState() {
  const { org } = useProjectContext();
  const { selectedVirtualMcp } = useChatPrefs();

  const defaultAgent = getWellKnownDecopilotVirtualMCP(org.id);
  const displayAgent = selectedVirtualMcp ?? defaultAgent;

  return (
    <Chat.EmptyState>
      <div className="flex flex-col items-center gap-3 md:gap-6 w-full px-4">
        <div className="flex flex-col items-center justify-center gap-2 md:gap-4 p-0 text-center">
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
          <div className="text-muted-foreground text-center text-xs md:text-sm max-w-md line-clamp-2">
            {displayAgent.description ??
              "Ask anything about configuring model providers or using MCP Mesh."}
          </div>
        </div>
        <Chat.IceBreakers />
      </div>
    </Chat.EmptyState>
  );
}

// ---------- Panel content ----------

function ChatPanelContent({ variant }: { variant?: "home" | "default" }) {
  const allKeys = useAiProviderKeys();
  const { isChatEmpty } = useChatStream();
  const [activePanel, setActivePanel] = useState<"chat" | "context">("chat");

  if (allKeys.length === 0) {
    const title = "No model provider connected";
    const description =
      "Connect to a model provider to unlock AI-powered features.";

    return (
      <Chat className="animate-in fade-in-0 duration-200">
        <Chat.Main className="flex flex-col items-center">
          <Chat.EmptyState>
            <Chat.NoAiProviderEmptyState
              title={title}
              description={description}
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
        ) : variant === "home" ? (
          <HomeEmptyState
            onOpenContextPanel={() => setActivePanel("context")}
          />
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

export function ChatPanel({ variant }: { variant?: "home" | "default" }) {
  return (
    <ErrorBoundary fallback={<Chat.Skeleton />}>
      <Suspense fallback={<Chat.Skeleton />}>
        <ChatPanelContent variant={variant} />
      </Suspense>
    </ErrorBoundary>
  );
}
