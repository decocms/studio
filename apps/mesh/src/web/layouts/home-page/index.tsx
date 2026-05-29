import {
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
  useVirtualMCP,
} from "@decocms/mesh-sdk";
import { useState } from "react";
import { LayoutAlt04, Plus, X } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { cn } from "@deco/ui/lib/utils.ts";
import { Chat } from "@/web/components/chat";
import { useChatPrefs } from "@/web/components/chat/context";
import { NoAiProviderEmptyState } from "@/web/components/chat/no-ai-provider-empty-state";
import { AddTileDrawer } from "@/web/components/home/add-tile-drawer";
import { HomeGrid, useHomeGridStats } from "@/web/components/home/home-grid";
import { useAiProviderKeys } from "@/web/hooks/collections/use-ai-providers";
import { useCurrentLink } from "@/web/hooks/use-current-link";
import { useDecoCredits } from "@/web/hooks/use-deco-credits";
import {
  agentHasClonableSource,
  hasLocalCliHarness,
} from "@/web/lib/agent-capabilities";
import { authClient } from "@/web/lib/auth-client";
import { Toolbar } from "@/web/layouts/agent-shell-layout/toolbar";
import { HomeBackground } from "./background";

export function HomePage() {
  const { data: session } = authClient.useSession();
  const { org } = useProjectContext();
  const isMobile = useIsMobile();
  const allKeys = useAiProviderKeys();
  const link = useCurrentLink();
  const { selectedVirtualMcp } = useChatPrefs();
  const defaultAgent = getWellKnownDecopilotVirtualMCP(org.id);
  const displayAgent = selectedVirtualMcp ?? defaultAgent;
  const fullVm = useVirtualMCP(displayAgent.id);
  const {
    hasDecoKey,
    isZeroBalance,
    isInitialFreeCredit,
    balanceDollars,
    hasOnlyDecoProvider,
  } = useDecoCredits();
  const [isEditMode, setEditMode] = useState(false);
  const [addTileOpen, setAddTileOpen] = useState(false);
  const { hasVisibleTiles } = useHomeGridStats(org.slug);

  const isClonableAgent = agentHasClonableSource(fullVm?.metadata);
  const showProviderEmptyState =
    allKeys.length === 0 && !(isClonableAgent && hasLocalCliHarness(link));

  if (showProviderEmptyState) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="min-h-full flex items-center justify-center px-4 py-10">
          <NoAiProviderEmptyState />
        </div>
      </div>
    );
  }

  const userName = session?.user?.name?.split(" ")[0] || "there";
  const showEyebrow =
    hasDecoKey && isInitialFreeCredit && balanceDollars != null;
  const showNoCreditsEyebrow =
    hasDecoKey && isZeroBalance && hasOnlyDecoProvider;
  const eyebrow = showEyebrow ? (
    <Chat.CreditsEyebrow balanceDollars={balanceDollars} />
  ) : showNoCreditsEyebrow ? (
    <Chat.NoCreditsEyebrow />
  ) : null;

  if (isMobile) {
    return (
      <div className="flex-1 relative flex flex-col items-center overflow-y-auto">
        <HomeBackground />
        <div className="relative flex flex-col items-center justify-center w-full pt-28 pb-8 px-4">
          {eyebrow && <div className="mb-4">{eyebrow}</div>}
          <p className="text-3xl font-medium text-foreground text-center max-w-[280px]">
            What's on your mind, {userName}?
          </p>
        </div>
        <div className="relative w-full flex flex-col gap-4 pb-8 px-4">
          <Chat.Input showConnectionsBanner />
        </div>
        <div className="relative w-full px-4 pb-8">
          <HomeGrid isEditMode={false} />
        </div>
      </div>
    );
  }

  return (
    <>
      <Toolbar.Right>
        <CustomizeToolbar
          isEditMode={isEditMode}
          onEnter={() => setEditMode(true)}
          onExit={() => setEditMode(false)}
          onAddTile={() => setAddTileOpen(true)}
        />
      </Toolbar.Right>
      <AddTileDrawer open={addTileOpen} onOpenChange={setAddTileOpen} />
      <div className="flex-1 relative flex flex-col min-h-0">
        <HomeBackground />
        <div className="flex-1 relative flex flex-col overflow-y-auto">
          <div
            className={cn(
              "relative flex flex-col items-center px-10 pb-4",
              hasVisibleTiles || isEditMode ? "pt-32" : "flex-1 justify-center",
            )}
          >
            <div className="flex flex-col items-center w-full max-w-[672px]">
              <div className="text-center mb-10">
                {eyebrow && <div className="mb-4">{eyebrow}</div>}
                <p className="text-3xl font-medium text-foreground">
                  What's on your mind, {userName}?
                </p>
              </div>
              <div className="relative w-full">
                <Capybara />
                <Chat.Input showConnectionsBanner />
              </div>
            </div>
            <div className="relative w-full mt-10 mx-auto max-w-[1280px] px-2 pb-16">
              <HomeGrid isEditMode={isEditMode} />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function CustomizeToolbar({
  isEditMode,
  onEnter,
  onExit,
  onAddTile,
}: {
  isEditMode: boolean;
  onEnter: () => void;
  onExit: () => void;
  onAddTile: () => void;
}) {
  if (isEditMode) {
    return (
      <>
        <button
          type="button"
          onClick={onAddTile}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
          title="Add a tile from any agent"
        >
          <Plus size={14} />
          Add tile
        </button>
        <Button size="sm" onClick={onExit} className="gap-1.5 h-7 text-xs">
          <X size={14} />
          Done
        </Button>
      </>
    );
  }
  return (
    <button
      type="button"
      onClick={onEnter}
      className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
      title="Customize your home"
    >
      <LayoutAlt04 size={14} />
      Customize
    </button>
  );
}

function Capybara() {
  return (
    <img
      src="/home/capybara.png"
      alt=""
      aria-hidden
      className="pointer-events-none absolute -top-10 right-6 z-20 h-12 w-auto select-none"
    />
  );
}
