import {
  getWellKnownDecopilotVirtualMCP,
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
  useVirtualMCP,
  virtualMcpItemQueryOptions,
} from "@decocms/mesh-sdk";
import { useQuery, useSuspenseQueries } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Check, LayoutAlt04, Plus, X } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { cn } from "@deco/ui/lib/utils.ts";
import { Chat } from "@/web/components/chat";
import { useChatPrefs } from "@/web/components/chat/context";
import { NoAiProviderEmptyState } from "@/web/components/chat/no-ai-provider-empty-state";
import { AddTileDrawer } from "@/web/components/home/add-tile-drawer";
import {
  HomeEditProvider,
  useHomeEdit,
} from "@/web/components/home/home-edit-context";
import { HomeGrid, useHomeGridStats } from "@/web/components/home/home-grid";
import {
  aiProviderKeysQueryOptions,
  useAiProviderKeys,
} from "@/web/hooks/collections/use-ai-providers";
import { useCurrentLink } from "@/web/hooks/use-current-link";
import { useDecoCredits } from "@/web/hooks/use-deco-credits";
import { homeNextActionsQueryOptions } from "@/web/hooks/use-home-next-actions";
import { organizationSettingsQueryOptions } from "@/web/hooks/use-organization-settings";
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
  const link = useCurrentLink();
  const { selectedVirtualMcp } = useChatPrefs();
  const defaultAgent = getWellKnownDecopilotVirtualMCP(org.id);
  const displayAgent = selectedVirtualMcp ?? defaultAgent;

  // Warm the tile-gating home feed in parallel with the self tool calls below.
  // Plain (non-suspense) query so a flaky feed never blanks the home — it only
  // starts the fetch early; useHomeGridStats reads the same cache entry.
  useQuery(homeNextActionsQueryOptions(org.slug));

  // Resolve the self MCP client once, then fire every independent self tool call
  // in a single parallel batch. Without this, the stacked useSuspenseQuery hooks
  // below each suspend before the next starts, serializing into a waterfall that
  // delayed home-next-actions (and thus the tiles) by seconds.
  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  useSuspenseQueries({
    queries: [
      aiProviderKeysQueryOptions(selfClient, org.id),
      organizationSettingsQueryOptions(selfClient, org.id),
      virtualMcpItemQueryOptions(org.id, displayAgent.id, selfClient),
    ],
  });

  const allKeys = useAiProviderKeys();
  const fullVm = useVirtualMCP(displayAgent.id);
  const {
    hasDecoKey,
    isZeroBalance,
    isInitialFreeCredit,
    balanceDollars,
    hasOnlyDecoProvider,
  } = useDecoCredits();
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

  return (
    <HomeEditProvider>
      {isMobile ? (
        <MobileHome eyebrow={eyebrow} userName={userName} />
      ) : (
        <DesktopHome
          eyebrow={eyebrow}
          userName={userName}
          hasVisibleTiles={hasVisibleTiles}
        />
      )}
    </HomeEditProvider>
  );
}

function MobileHome({
  eyebrow,
  userName,
}: {
  eyebrow: ReactNode;
  userName: string;
}) {
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

function DesktopHome({
  eyebrow,
  userName,
  hasVisibleTiles,
}: {
  eyebrow: ReactNode;
  userName: string;
  hasVisibleTiles: boolean;
}) {
  const { isEditMode, enter, save, cancel, hasChanges } = useHomeEdit();
  const [addTileOpen, setAddTileOpen] = useState(false);

  return (
    <>
      <Toolbar.Right>
        <CustomizeToolbar
          isEditMode={isEditMode}
          hasChanges={hasChanges}
          onEnter={enter}
          onSave={save}
          onCancel={cancel}
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
  hasChanges,
  onEnter,
  onSave,
  onCancel,
  onAddTile,
}: {
  isEditMode: boolean;
  hasChanges: boolean;
  onEnter: () => void;
  onSave: () => void;
  onCancel: () => void;
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
        <Button
          size="sm"
          variant="ghost"
          onClick={onCancel}
          className="gap-1.5 h-7 text-xs"
        >
          <X size={14} />
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={onSave}
          disabled={!hasChanges}
          className="gap-1.5 h-7 text-xs"
        >
          <Check size={14} />
          Save
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
      className="pointer-events-none absolute -top-16 right-6 z-20 h-20 w-auto select-none"
    />
  );
}
