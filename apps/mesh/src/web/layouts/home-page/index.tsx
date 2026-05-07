/**
 * Home page — one page, two regions:
 *   1. Top:    chat composer + agents strip (unchanged from today's home).
 *   2. Bottom: customisable tile board. Empty by default; tiles appear
 *              when the user pins them.
 *
 * There is no mode toggle. The tile area is hidden until the user adds
 * something. A subtle "Customize" button in the toolbar opens edit mode
 * for the tile area only.
 */

import { AgentsList } from "@/web/components/home/agents-list.tsx";
import { Chat } from "@/web/components/chat";
import { NoAiProviderEmptyState } from "@/web/components/chat/no-ai-provider-empty-state";
import { ImportFromDecoDialog } from "@/web/components/import-from-deco-dialog.tsx";
import { IntegrationIcon } from "@/web/components/integration-icon";
import { useAiProviderKeys } from "@/web/hooks/collections/use-ai-providers";
import { authClient } from "@/web/lib/auth-client";
import { KEYS } from "@/web/lib/query-keys";
import { useDecoCredits } from "@/web/hooks/use-deco-credits";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import {
  ArrowRight,
  LayoutAlt04,
  Plus,
  Settings02,
  Trash01,
} from "@untitledui/icons";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useProjectContext } from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { Toolbar } from "@/web/layouts/agent-shell-layout/toolbar";
import { TileBoard } from "@/web/components/home/tiles/tile-board";
import { TileAddSheet } from "@/web/components/home/tiles/tile-add-sheet";
import { useHomeBoard } from "@/web/components/home/tiles/use-home-board";

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

export function HomePage() {
  const { data: session } = authClient.useSession();
  const { org } = useProjectContext();
  const boardApi = useHomeBoard(org.slug);
  const [importOpen, setImportOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [isEditMode, setEditMode] = useState(false);

  const isDecoUser = useIsDecoUser();
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

  if (isMobile) {
    return (
      <>
        <div className="flex-1 relative flex flex-col items-center px-4 overflow-y-auto">
          <div className="flex flex-col items-center justify-center w-full pt-16 pb-8">
            {showEyebrow && (
              <div className="mb-4">
                <Chat.CreditsEyebrow balanceDollars={balanceDollars} />
              </div>
            )}
            {showNoCreditsEyebrow && (
              <div className="mb-4">
                <Chat.NoCreditsEyebrow />
              </div>
            )}
            <p className="text-3xl font-medium text-foreground text-center max-w-[280px]">
              What's on your mind, {userName}?
            </p>
          </div>
          <div className="w-full flex flex-col gap-4 pb-8">
            <AgentsList />
            <Chat.Input showConnectionsBanner />
          </div>
          {hasTiles && (
            <div className="w-full pb-8">
              <TileBoard
                board={boardApi.board}
                isEditMode={false}
                onMove={boardApi.moveTile}
                onResize={boardApi.resizeTile}
                onRemove={boardApi.removeTile}
              />
            </div>
          )}
          {isDecoUser && (
            <div className="w-full pb-4">
              <ImportDecoSiteBanner onClick={() => setImportOpen(true)} />
            </div>
          )}
        </div>
        <ImportFromDecoDialog open={importOpen} onOpenChange={setImportOpen} />
      </>
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
          onAdd={() => setAddOpen(true)}
          onResetToStarter={boardApi.resetToStarter}
          onClearAll={() => {
            boardApi.clearAll();
            setEditMode(false);
          }}
        />
      </Toolbar.Right>

      <div className="flex-1 relative flex flex-col overflow-y-auto">
        {/* Top: chat + agents (always rendered, identical to today) */}
        <div className="flex flex-col items-center px-10 pt-16 pb-4">
          <div className="flex flex-col items-center w-full max-w-[672px]">
            <div className="text-center mb-10">
              {showEyebrow && (
                <div className="mb-4">
                  <Chat.CreditsEyebrow balanceDollars={balanceDollars} />
                </div>
              )}
              {showNoCreditsEyebrow && (
                <div className="mb-4">
                  <Chat.NoCreditsEyebrow />
                </div>
              )}
              <p className="text-3xl font-medium text-foreground">
                What's on your mind, {userName}?
              </p>
            </div>
            <div className="w-full">
              <Chat.Input showConnectionsBanner />
            </div>
          </div>
          <div className="w-full mt-10 mx-auto">
            <AgentsList />
          </div>
        </div>

        {/* Bottom: tile board (only when there are tiles) */}
        {hasTiles ? (
          <div className="w-full mt-12 mx-auto max-w-[1280px] px-4 pb-10">
            <TileBoard
              board={boardApi.board}
              isEditMode={isEditMode}
              onMove={boardApi.moveTile}
              onResize={boardApi.resizeTile}
              onRemove={boardApi.removeTile}
            />
          </div>
        ) : (
          <EmptyHint
            visible={!isDecoUser}
            onAdd={() => {
              setEditMode(true);
              setAddOpen(true);
            }}
            onUseStarter={() => {
              boardApi.resetToStarter();
              setEditMode(true);
            }}
          />
        )}

        {isDecoUser && !hasTiles && (
          <div className="px-10 pb-6 pt-10">
            <div className="w-full max-w-[500px] mx-auto">
              <ImportDecoSiteBanner onClick={() => setImportOpen(true)} />
            </div>
          </div>
        )}
      </div>

      <ImportFromDecoDialog open={importOpen} onOpenChange={setImportOpen} />
      <TileAddSheet
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdd={(tile) => {
          boardApi.addTile(tile);
          // Newly added tile means we have at least one — keep edit mode
          // on so the user can immediately move/resize it.
        }}
      />
    </>
  );
}

function CustomizeToolbar({
  isEditMode,
  hasTiles,
  onEnter,
  onExit,
  onAdd,
  onResetToStarter,
  onClearAll,
}: {
  isEditMode: boolean;
  hasTiles: boolean;
  onEnter: () => void;
  onExit: () => void;
  onAdd: () => void;
  onResetToStarter: () => void;
  onClearAll: () => void;
}) {
  if (isEditMode) {
    return (
      <>
        <Button
          size="sm"
          variant="ghost"
          onClick={onAdd}
          className="gap-1.5 h-7 text-xs"
        >
          <Plus size={14} />
          Add tile
        </Button>
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
            <DropdownMenuItem onSelect={onResetToStarter}>
              Use starter layout
            </DropdownMenuItem>
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

function EmptyHint({
  visible,
  onAdd,
  onUseStarter,
}: {
  visible: boolean;
  onAdd: () => void;
  onUseStarter: () => void;
}) {
  if (!visible) return null;
  return (
    <div className="w-full mt-10 mx-auto max-w-[672px] px-10 pb-6">
      <div className="rounded-xl border border-dashed border-border bg-background/40 px-4 py-3 flex items-center gap-3">
        <span className="flex size-7 items-center justify-center rounded-md bg-primary/10 text-primary shrink-0">
          <LayoutAlt04 size={14} />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">
            Pin tiles to your home
          </p>
          <p className="text-xs text-muted-foreground">
            Recent tasks, dashboards, notes — anything you want here every day.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={onUseStarter}>
          Use starter
        </Button>
        <Button size="sm" onClick={onAdd} className="gap-1.5">
          <Plus size={14} />
          Add tile
        </Button>
      </div>
    </div>
  );
}
