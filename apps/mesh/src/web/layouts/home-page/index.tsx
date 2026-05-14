/**
 * Home page — chat on top, customisable tile board below. Tiles arrive
 * on the board when the user starts a matching preset task from the
 * side panel; the board itself is a 3-col dnd grid with edit-mode
 * affordances (add, resize, remove).
 */

import { LayoutAlt04, Settings02, Trash01 } from "@untitledui/icons";
import { useState } from "react";
import { Chat } from "@/web/components/chat";
import { NoAiProviderEmptyState } from "@/web/components/chat/no-ai-provider-empty-state";
import { useAiProviderKeys } from "@/web/hooks/collections/use-ai-providers";
import { useDecoCredits } from "@/web/hooks/use-deco-credits";
import { authClient } from "@/web/lib/auth-client";
import { Button } from "@deco/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { useProjectContext } from "@decocms/mesh-sdk";
import { TileBoard } from "@/web/components/home/tiles/tile-board";
import { useHomeBoard } from "@/web/components/home/tiles/use-home-board";
import { Toolbar } from "@/web/layouts/agent-shell-layout/toolbar";
import { HomeBackground } from "./background";

export function HomePage() {
  const { data: session } = authClient.useSession();
  const { org } = useProjectContext();
  const boardApi = useHomeBoard(org.slug);
  const [isEditMode, setEditMode] = useState(false);
  const isMobile = useIsMobile();
  const allKeys = useAiProviderKeys();
  const {
    hasDecoKey,
    isZeroBalance,
    isInitialFreeCredit,
    balanceDollars,
    hasOnlyDecoProvider,
  } = useDecoCredits();

  if (allKeys.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-4 py-10">
        <NoAiProviderEmptyState />
      </div>
    );
  }

  const userName = session?.user?.name?.split(" ")[0] || "there";
  const hasTiles = boardApi.board.tiles.length > 0;
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
        {hasTiles && (
          <div className="relative w-full pb-8">
            <TileBoard
              board={boardApi.board}
              isEditMode={false}
              onMove={boardApi.moveTile}
              onResize={boardApi.resizeTile}
              onRemove={boardApi.removeTile}
              onUpdateConfig={boardApi.updateTileConfig}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <Toolbar.Right>
        <CustomizeToolbar
          isEditMode={isEditMode}
          hasTiles={hasTiles}
          onEnter={() => setEditMode(true)}
          onExit={() => setEditMode(false)}
          onClearAll={() => {
            boardApi.clearAll();
            setEditMode(false);
          }}
        />
      </Toolbar.Right>
      {/* Outer wrapper hosts the fixed background; inner div is the
          scroll container, so the corner art stays put as content scrolls. */}
      <div className="flex-1 relative flex flex-col min-h-0">
        <HomeBackground />
        <div className="flex-1 relative flex flex-col overflow-y-auto">
          <div
            className={
              hasTiles
                ? "relative flex flex-col items-center px-10 pt-48 pb-4"
                : "relative flex-1 flex flex-col items-center justify-center px-10 pb-4"
            }
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
          </div>
          {hasTiles && (
            <div className="relative w-full mt-16 mx-auto max-w-[1080px] px-6 pb-16">
              <TileBoard
                board={boardApi.board}
                isEditMode={isEditMode}
                onMove={boardApi.moveTile}
                onResize={boardApi.resizeTile}
                onRemove={boardApi.removeTile}
                onUpdateConfig={boardApi.updateTileConfig}
              />
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function CustomizeToolbar({
  isEditMode,
  hasTiles,
  onEnter,
  onExit,
  onClearAll,
}: {
  isEditMode: boolean;
  hasTiles: boolean;
  onEnter: () => void;
  onExit: () => void;
  onClearAll: () => void;
}) {
  if (!hasTiles && !isEditMode) return null;
  if (isEditMode) {
    return (
      <>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
              title="Board options"
            >
              <Settings02 size={14} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Home tiles</DropdownMenuLabel>
            {hasTiles && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={onClearAll}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash01 size={14} className="mr-2" />
                  Remove all tiles
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="sm" onClick={onExit} className="gap-1.5 h-7 text-xs">
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
  // -top-10 lifts the body well above the chat input so only the bottom
  // ~8px overlaps — the head reads as peeking out from behind. z-20 sits
  // above the chat composer's stacking context.
  return (
    <img
      src="/home/capybara.png"
      alt=""
      aria-hidden
      className="pointer-events-none absolute -top-10 right-6 z-20 h-12 w-auto select-none"
    />
  );
}
