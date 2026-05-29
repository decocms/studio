/**
 * Renders the home "next actions" data source as a tile-board grid.
 * Each prompt and agent UI tile becomes a grid item; positions/sizes/
 * hidden state persist to localStorage scoped by org slug.
 */

import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
import { Suspense } from "react";
import { useMCPClient, useProjectContext } from "@decocms/mesh-sdk";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { ArrowRight, X } from "@untitledui/icons";
import { MCPAppRenderer } from "@/mcp-apps/mcp-app-renderer.tsx";
import { AgentAvatar } from "@/web/components/agent-icon";
import { ErrorBoundary } from "@/web/components/error-boundary";
import {
  type HomePromptEntry,
  type HomeTileEntry,
  useHomeNextActions,
} from "@/web/hooks/use-home-next-actions";
import { useStartThreadFromPrompt } from "@/web/hooks/use-start-thread-from-prompt";
import { TileBoard } from "./tile-board/tile-board";
import { useBoardLayout } from "./tile-board/use-board-layout";
import type { TileInstance } from "./tile-board/types";

interface HomeGridProps {
  isEditMode: boolean;
}

// Shared so HomeGrid and useHomeGridStats agree on what "a tile" looks
// like before the user resizes it.
const TILE_DEFAULT_SIZE = { w: 2, h: 4 } as const;
const TILE_MIN_SIZE = { w: 1, h: 2 } as const;
const PROMPT_DEFAULT_SIZE = { w: 1, h: 1 } as const;

/** Stable, deterministic id so the persisted layout matches the same item
 *  on the next render. */
function promptCandidateId(p: HomePromptEntry): string {
  return `prompt:${p.agentId}:${p.promptName || "blank"}`;
}

function tileCandidateId(t: HomeTileEntry): string {
  // Disambiguates multiple tiles pinned to the same agent by including
  // the resource URI — each (agent, resource) pair is its own grid tile.
  return `tile:${t.agentId}:${t.resourceUri}`;
}

function entryToPrompt(entry: HomePromptEntry): Prompt {
  return {
    name: entry.promptName,
    title: entry.title,
    description: entry.description,
    arguments: entry.arguments,
    _meta: entry._meta,
  };
}

/** Bundles the prompt/blank thread launch for every surface that needs
 *  it (cards, chips, tile headers, error fallback). One source of truth
 *  for what clicking a prompt does. */
function usePromptEntryAction(agentId: string) {
  const { start, startBlank, dialog, starting } = useStartThreadFromPrompt({
    agentId,
  });
  const open = (entry: HomePromptEntry) => {
    if (!entry.promptName) {
      void startBlank();
      return;
    }
    void start(entryToPrompt(entry));
  };
  return { open, startBlank, dialog, starting };
}

interface PromptCandidate {
  kind: "prompt";
  id: string;
  data: HomePromptEntry;
}

interface TileCandidate {
  kind: "tile";
  id: string;
  data: HomeTileEntry;
}

type Candidate = PromptCandidate | TileCandidate;

function PromptTile({
  entry,
  isEditMode,
}: {
  entry: HomePromptEntry;
  isEditMode: boolean;
}) {
  const { open, dialog, starting } = usePromptEntryAction(entry.agentId);

  return (
    <>
      <button
        type="button"
        onClick={() => open(entry)}
        disabled={starting || isEditMode}
        aria-busy={starting}
        className={cn(
          "group/tile relative flex h-full w-full items-center gap-3 px-4 py-3 text-left bg-card",
          !isEditMode && "cursor-pointer transition-colors hover:bg-accent/40",
          isEditMode && "cursor-default pl-12",
          starting && "opacity-60",
        )}
      >
        <AgentAvatar icon={entry.agentIcon} name={entry.agentName} size="sm+" />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-sm font-medium text-foreground leading-snug">
            {entry.title}
          </div>
          <div className="truncate text-xs text-muted-foreground mt-0.5">
            {entry.agentName}
          </div>
        </div>
        {!isEditMode && (
          <ArrowRight
            size={16}
            className="shrink-0 text-muted-foreground opacity-0 -translate-x-1 transition-all duration-200 group-hover/tile:opacity-100 group-hover/tile:translate-x-0"
            aria-hidden
          />
        )}
      </button>
      {dialog}
    </>
  );
}

function PromptChip({
  entry,
  isEditMode,
  onHide,
}: {
  entry: HomePromptEntry;
  isEditMode: boolean;
  onHide: () => void;
}) {
  const { open, dialog, starting } = usePromptEntryAction(entry.agentId);

  return (
    <>
      <div className="group/chip relative">
        <button
          type="button"
          onClick={() => !isEditMode && open(entry)}
          disabled={starting || isEditMode}
          aria-busy={starting}
          className={cn(
            "flex w-full items-center gap-3 rounded-2xl bg-card card-shadow px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
            !isEditMode &&
              "transition-colors hover:bg-accent/40 cursor-pointer",
            isEditMode && "cursor-default",
            starting && "opacity-60",
          )}
        >
          <AgentAvatar
            icon={entry.agentIcon}
            name={entry.agentName}
            size="sm+"
          />
          <div className="min-w-0 flex-1">
            <div className="line-clamp-2 text-sm font-medium text-foreground leading-snug">
              {entry.title}
            </div>
            <div className="truncate text-xs text-muted-foreground mt-0.5">
              {entry.agentName}
            </div>
          </div>
          {!isEditMode && (
            <ArrowRight
              size={16}
              className="shrink-0 text-muted-foreground opacity-0 -translate-x-1 transition-all duration-200 group-hover/chip:opacity-100 group-hover/chip:translate-x-0"
              aria-hidden
            />
          )}
        </button>
        {isEditMode && (
          <button
            type="button"
            onClick={onHide}
            aria-label="Remove tile"
            className="absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full bg-background border border-border text-muted-foreground shadow-sm hover:bg-muted hover:text-foreground"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {dialog}
    </>
  );
}

function PromptChipsRowSkeleton() {
  return (
    <div className="mt-4 grid w-full grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      {Array.from({ length: 3 }, (_, i) => (
        <div
          key={`chip-skeleton-${i}`}
          className="flex w-full items-center gap-3 rounded-2xl bg-card card-shadow px-3 py-2.5"
        >
          <Skeleton className="size-10 rounded-xl" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-2.5 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

function AgentUITile({
  tile,
  prompts,
  isEditMode,
  tileWidth,
}: {
  tile: HomeTileEntry;
  prompts: HomePromptEntry[];
  isEditMode: boolean;
  /** Tile width in grid columns. We only render the inline chip column
   *  when there's enough horizontal space (≥ 2 cols) so a narrow 1×N tile
   *  doesn't squeeze the embedded UI. */
  tileWidth: number;
}) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: tile.connectionId,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const { open, startBlank, dialog, starting } = usePromptEntryAction(
    tile.agentId,
  );

  // Drop the blank-fallback card — clicking the header already covers it.
  const promptChips = prompts.filter((p) => !!p.promptName);

  return (
    <div className="flex h-full w-full flex-col gap-3 p-3">
      <button
        type="button"
        onClick={() => void startBlank()}
        disabled={starting || isEditMode}
        aria-busy={starting}
        className={cn(
          "flex items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-progress disabled:opacity-60",
          isEditMode && "pl-10 pr-10",
        )}
      >
        <AgentAvatar icon={tile.agentIcon} name={tile.agentName} size="sm+" />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="truncate text-sm font-medium text-foreground">
            {tile.agentName}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {isEditMode ? "Drag to rearrange" : "Open chat"}
          </div>
        </div>
      </button>
      <div className="flex min-h-0 flex-1 gap-3 overflow-hidden">
        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
          <MCPAppRenderer
            resourceURI={tile.resourceUri}
            orgId={org.id}
            client={client}
            displayMode="fullscreen"
            minHeight={tile.minHeight ?? 200}
            maxHeight={tile.maxHeight ?? 4000}
            className="h-full"
          />
        </div>
        {promptChips.length > 0 && !isEditMode && tileWidth >= 2 && (
          // Right-side column of action chips. `overflow-hidden` clips
          // overflow gracefully so a long list never spills outside the
          // tile — chips that don't fit are simply not shown, no scroll.
          <div className="flex w-44 shrink-0 flex-col gap-2 overflow-hidden">
            {promptChips.map((entry) => (
              <button
                key={entry.promptName}
                type="button"
                onClick={() => open(entry)}
                disabled={starting}
                className="shrink-0 rounded-lg border border-border bg-background px-2.5 py-2 text-left text-xs leading-snug text-foreground transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-progress disabled:opacity-60"
              >
                <span className="line-clamp-2">{entry.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {dialog}
    </div>
  );
}

function TileLoadingFallback({
  icon,
  name,
}: {
  icon: string | null;
  name: string;
}) {
  return (
    <div className="flex h-full w-full flex-col gap-3 p-5 opacity-60">
      <div className="flex items-center gap-2.5">
        <AgentAvatar icon={icon} name={name} size="sm+" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            {name}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            Loading tile…
          </div>
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-2 pt-1">
        <Skeleton className="h-3 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    </div>
  );
}

/**
 * Used when the embedded iframe fails to load — instead of a dead "Tile
 * unavailable" card we show the agent's prompts as clickable chips so
 * the user can still kick off actions. Keeps the failed UI tile useful
 * rather than throwing the prompts away with it.
 */
function TileErrorFallback({
  tile,
  prompts,
  isEditMode,
}: {
  tile: HomeTileEntry;
  prompts: HomePromptEntry[];
  isEditMode: boolean;
}) {
  const { open, startBlank, dialog, starting } = usePromptEntryAction(
    tile.agentId,
  );
  const chips = prompts.filter((p) => !!p.promptName);

  return (
    <div className="flex h-full w-full flex-col gap-3 p-4">
      <button
        type="button"
        onClick={() => void startBlank()}
        disabled={starting || isEditMode}
        className={cn(
          "flex items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
          isEditMode && "pl-10 pr-10",
        )}
      >
        <AgentAvatar icon={tile.agentIcon} name={tile.agentName} size="sm+" />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="truncate text-sm font-medium text-foreground">
            {tile.agentName}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            UI unavailable — open chat
          </div>
        </div>
      </button>
      {chips.length > 0 && !isEditMode && (
        <div className="grid grid-cols-1 gap-2 overflow-hidden sm:grid-cols-2">
          {chips.map((entry) => (
            <button
              key={entry.promptName}
              type="button"
              onClick={() => !isEditMode && open(entry)}
              disabled={starting}
              className="rounded-lg border border-border bg-background px-2.5 py-2 text-left text-xs leading-snug text-foreground transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-progress disabled:opacity-60"
            >
              <span className="line-clamp-2">{entry.title}</span>
            </button>
          ))}
        </div>
      )}
      {dialog}
    </div>
  );
}

export function HomeGrid({ isEditMode }: HomeGridProps) {
  const { org } = useProjectContext();
  const { isLoading, prompts, tiles } = useHomeNextActions(org.slug);

  // Agents that have a UI tile own their prompts — those prompts render
  // inline inside the tile, not as their own grid cards.
  const tileAgentIds = new Set(tiles.map((t) => t.agentId));
  const promptsByAgentId = new Map<string, HomePromptEntry[]>();
  for (const p of prompts) {
    const bucket = promptsByAgentId.get(p.agentId);
    if (bucket) bucket.push(p);
    else promptsByAgentId.set(p.agentId, [p]);
  }
  const loosePrompts = prompts.filter((p) => !tileAgentIds.has(p.agentId));

  // Build unified candidate list. Tile agents bring their prompts inline,
  // so only loose prompts become standalone grid cards.
  const candidates: Candidate[] = [
    ...tiles.map<TileCandidate>((t) => ({
      kind: "tile",
      id: tileCandidateId(t),
      data: t,
    })),
    ...loosePrompts.map<PromptCandidate>((p) => ({
      kind: "prompt",
      id: promptCandidateId(p),
      data: p,
    })),
  ];
  const candidatesById = new Map(candidates.map((c) => [c.id, c] as const));

  const layout = useBoardLayout(
    org.slug,
    candidates.map((c) => ({
      id: c.id,
      defaultSize: c.kind === "tile" ? TILE_DEFAULT_SIZE : PROMPT_DEFAULT_SIZE,
      // Agent UI tiles need at least 2 rows to leave the iframe room
      // under the header — at 1 row the embedded UI collapses to a
      // sliver. Prompt tiles can stay at 1×1.
      minSize: c.kind === "tile" ? TILE_MIN_SIZE : undefined,
    })),
  );

  const renderTile = (instance: TileInstance) => {
    const candidate = candidatesById.get(instance.id);
    if (!candidate) return null;
    if (candidate.kind === "tile") {
      const agentPrompts = promptsByAgentId.get(candidate.data.agentId) ?? [];
      return (
        <ErrorBoundary
          fallback={
            <TileErrorFallback
              tile={candidate.data}
              prompts={agentPrompts}
              isEditMode={isEditMode}
            />
          }
        >
          <Suspense
            fallback={
              <TileLoadingFallback
                icon={candidate.data.agentIcon}
                name={candidate.data.agentName}
              />
            }
          >
            <AgentUITile
              tile={candidate.data}
              prompts={agentPrompts}
              isEditMode={isEditMode}
              tileWidth={instance.w}
            />
          </Suspense>
        </ErrorBoundary>
      );
    }
    return <PromptTile entry={candidate.data} isEditMode={isEditMode} />;
  };

  if (isLoading) return <PromptChipsRowSkeleton />;

  const isEmpty = layout.snapshot.visible.length === 0;
  if (isEmpty && !isEditMode) return null;

  // If the visible board is "just prompts" (no agent UI tiles), bypass the
  // absolute-positioned grid and render content-hugging chips in a wrapping
  // row — the grid's fixed cells make small tiles look clipped/empty.
  const visibleHasUITile = layout.snapshot.visible.some((t) => {
    const cand = candidatesById.get(t.id);
    return cand?.kind === "tile";
  });

  if (!visibleHasUITile) {
    const visiblePrompts = layout.snapshot.visible
      .map((t) => candidatesById.get(t.id))
      .filter((c): c is PromptCandidate => c?.kind === "prompt");
    return (
      // Same container width / column count as the tile board. Keeps
      // chip columns aligned with whatever a future agent-UI tile would
      // occupy, so nothing shifts when the user adds their first tile.
      <div className="mt-4 grid w-full grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {visiblePrompts.map((c) => (
          <PromptChip
            key={c.id}
            entry={c.data}
            isEditMode={isEditMode}
            onHide={() => layout.hideTile(c.id)}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="mt-4 flex w-full max-w-7xl flex-col gap-4">
      <TileBoard
        tiles={layout.snapshot.visible}
        isEditMode={isEditMode}
        renderTile={renderTile}
        onMove={layout.moveTile}
        onResize={layout.resizeTile}
        onRemove={layout.hideTile}
      />
    </div>
  );
}

/**
 * Lightweight presence signal for the home page layout. We avoid
 * running the full board-layout computation here — that would double
 * up auto-placement work and risk disagreeing with `HomeGrid` if the
 * two ever drifted on defaults. Honoring the user's hidden-list isn't
 * worth that cost for what's ultimately a `pt-32` vs centered toggle.
 */
export function useHomeGridStats(orgSlug: string): {
  hasVisibleTiles: boolean;
} {
  const { prompts, tiles } = useHomeNextActions(orgSlug);
  return {
    hasVisibleTiles: tiles.length > 0 || prompts.length > 0,
  };
}
