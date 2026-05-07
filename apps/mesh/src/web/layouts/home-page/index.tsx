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
  Stars01,
  X,
} from "@untitledui/icons";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useProjectContext } from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
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
  const { org } = useProjectContext();
  const board = useHomeBoard(org.slug);

  if (board.board.layout === "tiles") {
    return <TilesHome boardApi={board} />;
  }
  return <SimpleHome boardApi={board} />;
}

/* ------------------------------- Simple ------------------------------- */

function SimpleHome({
  boardApi,
}: {
  boardApi: ReturnType<typeof useHomeBoard>;
}) {
  const { data: session } = authClient.useSession();
  const [importOpen, setImportOpen] = useState(false);
  const [introOpen, setIntroOpen] = useState(false);
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

  const showEyebrow =
    hasDecoKey && isInitialFreeCredit && balanceDollars != null;
  const showNoCreditsEyebrow =
    hasDecoKey && isZeroBalance && hasOnlyDecoProvider;

  if (isMobile) {
    return (
      <>
        <div className="flex-1 relative flex flex-col items-center px-4">
          <div className="flex-1 flex flex-col items-center justify-center w-full">
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
          <div className="w-full flex flex-col gap-4 pb-4">
            <AgentsList />
            <Chat.Input showConnectionsBanner />
          </div>
          {isDecoUser && (
            <div className="w-full">
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
        <button
          type="button"
          onClick={() => setIntroOpen(true)}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
          title="Customize your home"
        >
          <LayoutAlt04 size={14} />
          Customize
        </button>
      </Toolbar.Right>

      <div className="flex-1 relative flex flex-col items-center px-10 overflow-y-auto">
        <div className="flex-1 flex flex-col items-center justify-center w-full">
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
          <div className="w-full mt-10 mx-auto max-w-[672px]">
            <button
              type="button"
              onClick={() => setIntroOpen(true)}
              className="w-full flex items-center gap-3 rounded-lg border border-dashed border-border bg-background/40 hover:bg-muted/50 hover:border-primary/40 transition-colors px-4 py-3 text-left"
            >
              <span className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary shrink-0">
                <Stars01 size={14} />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">
                  Make this your home
                </p>
                <p className="text-xs text-muted-foreground">
                  Pin tiles from your agents and connected apps.
                </p>
              </div>
              <span className="text-xs text-muted-foreground shrink-0">
                Try it
              </span>
              <ArrowRight size={14} className="text-muted-foreground" />
            </button>
          </div>
        </div>
        {isDecoUser && (
          <div className="absolute bottom-6 left-0 right-0 px-10">
            <div className="w-full max-w-[500px] mx-auto">
              <ImportDecoSiteBanner onClick={() => setImportOpen(true)} />
            </div>
          </div>
        )}
      </div>
      <ImportFromDecoDialog open={importOpen} onOpenChange={setImportOpen} />
      <CustomizeIntroDialog
        open={introOpen}
        onOpenChange={setIntroOpen}
        onConfirm={(seed) => {
          boardApi.switchToTiles(seed);
          setIntroOpen(false);
        }}
      />
    </>
  );
}

function CustomizeIntroDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (seed: "starter" | "empty") => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Stars01 size={16} />
            Make this your home
          </DialogTitle>
          <DialogDescription>
            Switch to a customisable board with tiles. Pin recent agents, stats,
            and dashboards from your connected apps.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-2 my-2 text-sm text-muted-foreground">
          <li className="flex items-start gap-2">
            <span className="mt-1 size-1 rounded-full bg-foreground shrink-0" />
            Drag tiles to rearrange, pick from four sizes.
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-1 size-1 rounded-full bg-foreground shrink-0" />
            Switch back any time — your simple home is one click away.
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-1 size-1 rounded-full bg-foreground shrink-0" />
            Some tile data is mocked while we wire up real sources.
          </li>
        </ul>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Stay simple
          </Button>
          <Button variant="outline" onClick={() => onConfirm("empty")}>
            Start blank
          </Button>
          <Button onClick={() => onConfirm("starter")} className="gap-1.5">
            Try the tile board
            <ArrowRight size={14} />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------- Tiles ------------------------------- */

function TilesHome({
  boardApi,
}: {
  boardApi: ReturnType<typeof useHomeBoard>;
}) {
  const isMobile = useIsMobile();
  const [isEditMode, setEditMode] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  return (
    <>
      {!isMobile && (
        <Toolbar.Right>
          {isEditMode ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setAddOpen(true)}
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
                  <DropdownMenuLabel>Board</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={boardApi.resetToStarter}>
                    Reset to starter layout
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => {
                      boardApi.switchToSimple();
                      setEditMode(false);
                    }}
                  >
                    Switch to simple home
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                size="sm"
                onClick={() => setEditMode(false)}
                className="gap-1.5 h-7 text-xs"
              >
                Done
              </Button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setEditMode(true)}
              className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
              title="Customize"
            >
              <LayoutAlt04 size={14} />
              Customize
            </button>
          )}
        </Toolbar.Right>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1280px] px-6 py-6">
          {isMobile && (
            <div className="mb-4 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
              Open Studio on desktop to drag, resize, and customize your tiles.
            </div>
          )}

          {boardApi.board.tiles.length === 0 ? (
            <EmptyTileBoard
              onAdd={() => setAddOpen(true)}
              onSwitchToSimple={boardApi.switchToSimple}
              onResetToStarter={boardApi.resetToStarter}
            />
          ) : (
            <TileBoard
              board={boardApi.board}
              isEditMode={isEditMode && !isMobile}
              onMove={boardApi.moveTile}
              onResize={boardApi.resizeTile}
              onRemove={boardApi.removeTile}
            />
          )}
        </div>
      </div>

      <TileAddSheet
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdd={boardApi.addTile}
      />
    </>
  );
}

function EmptyTileBoard({
  onAdd,
  onSwitchToSimple,
  onResetToStarter,
}: {
  onAdd: () => void;
  onSwitchToSimple: () => void;
  onResetToStarter: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
      <span className="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <LayoutAlt04 size={20} />
      </span>
      <div>
        <h3 className="text-lg font-medium text-foreground">
          Your board is empty
        </h3>
        <p className="text-sm text-muted-foreground max-w-md">
          Add tiles from the catalog to start composing your home.
        </p>
      </div>
      <div className="flex gap-2">
        <Button onClick={onAdd} className="gap-1.5">
          <Plus size={14} />
          Add a tile
        </Button>
        <Button variant="outline" onClick={onResetToStarter}>
          Use starter layout
        </Button>
        <Button variant="ghost" onClick={onSwitchToSimple} className="gap-1.5">
          <X size={14} />
          Back to simple home
        </Button>
      </div>
    </div>
  );
}
