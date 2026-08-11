/**
 * Renders the home "next actions" data source as a tile-board grid.
 * Each prompt and agent UI tile becomes a grid item; positions/sizes/
 * hidden state persist to localStorage scoped by org slug.
 */

import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
import { Suspense } from "react";
import {
  getHomeTiles,
  isStudioPackAgent,
  mcpClientQueryOptions,
  useMCPClient,
  useMCPToolsListQuery,
  useProjectContext,
} from "@/sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { ArrowRight } from "@untitledui/icons";
import { toast } from "sonner";
import { useT } from "@/i18n/use-t.ts";
import { MCPAppRenderer } from "@/mcp-apps/mcp-app-renderer";
import { getUIResourceUri } from "@decocms/shared/mcp-apps/types";
import { AgentAvatar } from "@/components/agent-icon";
import { ErrorBoundary } from "@/components/error-boundary";
import { formatPinnedViewTabId } from "@/layouts/main-panel-tabs/tab-id";
import {
  type HomePromptEntry,
  type HomeTileEntry,
  useHomeNextActions,
} from "@/hooks/use-home-next-actions";
import {
  useDefaultHomeAgents,
  useHomeAgentsWriter,
} from "@/hooks/use-organization-settings";
import { useStartThreadFromPrompt } from "@/hooks/use-start-thread-from-prompt";
import { useStudioTools } from "@/lib/studio-tools";
import { KEYS } from "@/lib/query-keys";
import { TileBoard } from "./tile-board/tile-board";
import { useBoardLayout } from "./tile-board/use-board-layout";
import type { TileInstance } from "./tile-board/types";
import {
  NATIVE_TILES,
  NativeTile,
  type NativeTileDef,
  nativeCandidateId,
} from "./native-tiles";

interface HomeGridProps {
  isEditMode: boolean;
}

// Default tile footprint before the user resizes it. w:3 keeps agent tiles at
// half width on the 6-column grid (see tile-board/constants).
const TILE_DEFAULT_SIZE = { w: 3, h: 4 } as const;
const TILE_MIN_SIZE = { w: 1, h: 2 } as const;
const PROMPT_DEFAULT_SIZE = { w: 2, h: 1 } as const;

/** Stable, deterministic id so the persisted layout matches the same item
 *  on the next render. */
function promptCandidateId(p: HomePromptEntry): string {
  return `prompt:${p.agentId}:${p.promptName || "blank"}`;
}

function tileCandidateId(t: HomeTileEntry): string {
  // When a tileId exists (new tiles), use it for stable identity — this
  // allows multiple tiles backed by the same tool/resource with different
  // toolInput to coexist. Fall back to agent+resource for legacy tiles.
  if (t.tileId) return `tile:${t.tileId}`;
  return `tile:${t.agentId}:${t.resourceUri}`;
}

/** Secondary line under the card title. Quick-access agent cards (no
 *  promptName) put the agent name in the title slot, so their subtitle is
 *  the agent description; prompt cards keep the owning agent's name. */
function entrySubtitle(entry: HomePromptEntry): string {
  return entry.promptName ? entry.agentName : entry.description;
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

/** Resolves the main-panel tab id for a home tile so "Open chat" can
 *  open chat + the tile's UI side-by-side. Uses the non-suspending MCP
 *  client / tools-list queries so the tile chrome renders immediately
 *  (the queries piggy-back on TileAppPanel's cache). */
function useTileMainTab(tile: HomeTileEntry): string | undefined {
  const { org } = useProjectContext();

  // Non-suspending — shares the same cache key as TileAppPanel's
  // useMCPClient, so the client is typically already cached by the
  // time the user sees the tile.
  const { data: client } = useQuery(
    mcpClientQueryOptions({
      connectionId: tile.connectionId,
      orgId: org.id,
      orgSlug: org.slug,
    }),
  );

  // Resolve tool name from the connection's tools when not explicitly set.
  const { data: toolsResult } = useMCPToolsListQuery({
    client: client!,
    enabled: !!client && !tile.toolName,
  });

  const toolName =
    tile.toolName ??
    toolsResult?.tools.find(
      (t) => getUIResourceUri(t._meta) === tile.resourceUri,
    )?.name;

  return toolName
    ? formatPinnedViewTabId(tile.connectionId, toolName)
    : undefined;
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

interface NativeCandidate {
  kind: "native";
  id: string;
  data: NativeTileDef;
}

type Candidate = PromptCandidate | TileCandidate | NativeCandidate;

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
            {entrySubtitle(entry)}
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
  const { open, startBlank, dialog, starting } = usePromptEntryAction(
    tile.agentId,
  );

  // Drop the blank-fallback card — clicking the header already covers it.
  const promptChips = prompts.filter((p) => !!p.promptName);

  const mainTab = useTileMainTab(tile);

  const t = useT();
  return (
    <div className="relative flex h-full w-full flex-col p-3">
      {!isEditMode && (
        <button
          type="button"
          onClick={() =>
            void startBlank(mainTab ? { main: mainTab } : undefined)
          }
          disabled={starting}
          aria-busy={starting}
          className="mb-1 self-start rounded-md px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-progress disabled:opacity-60"
        >
          {t("home.homeGrid.openChat")}
        </button>
      )}
      <div className="flex min-h-0 flex-1 gap-3 overflow-hidden">
        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
          <Suspense fallback={<TilePanelSkeleton />}>
            <TileAppPanel tile={tile} orgId={org.id} orgSlug={org.slug} />
          </Suspense>
        </div>
        {promptChips.length > 0 && !isEditMode && tileWidth >= 2 && (
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

/** Owns the tile's live MCP connection so the connect suspends only the
 *  embedded panel (via the inner boundary above), not the whole tile. */
function TileAppPanel({
  tile,
  orgId,
  orgSlug,
}: {
  tile: HomeTileEntry;
  orgId: string;
  orgSlug: string;
}) {
  const client = useMCPClient({
    connectionId: tile.connectionId,
    orgId,
    orgSlug,
  });
  return (
    <MCPAppRenderer
      resourceURI={tile.resourceUri}
      orgId={orgId}
      orgSlug={orgSlug}
      connectionId={tile.connectionId}
      client={client}
      toolInput={tile.toolInput}
      displayMode="fullscreen"
      minHeight={tile.minHeight ?? 200}
      maxHeight={tile.maxHeight ?? 4000}
      className="h-full"
    />
  );
}

/** Fallback for just the embedded app panel — keeps the tile chrome visible
 *  while the (potentially slow) resource read is in flight. */
function TilePanelSkeleton() {
  return (
    <div className="flex h-full w-full flex-col gap-2 p-4">
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-3 w-1/2" />
      <Skeleton className="mt-1 h-full w-full rounded-md" />
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
  const t = useT();
  return (
    <div className="flex h-full w-full flex-col gap-3 p-5 opacity-60">
      <div className="flex items-center gap-2.5">
        <AgentAvatar icon={icon} name={name} size="sm+" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            {name}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {t("home.homeGrid.loadingTile")}
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
  const t = useT();
  const { open, startBlank, dialog, starting } = usePromptEntryAction(
    tile.agentId,
  );
  const chips = prompts.filter((p) => !!p.promptName);
  const mainTab = useTileMainTab(tile);

  return (
    <div className="flex h-full w-full flex-col gap-3 p-4">
      <button
        type="button"
        onClick={() => void startBlank(mainTab ? { main: mainTab } : undefined)}
        disabled={starting || isEditMode}
        className="mb-1 self-start rounded-md px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-progress disabled:opacity-60"
      >
        {t("home.homeGrid.openChat")}
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
  const t = useT();
  const { org } = useProjectContext();
  const {
    isLoading,
    prompts: allPrompts,
    tiles: allTiles,
  } = useHomeNextActions(org.slug);
  // Studio Pack onboarding agents (Brand Manager et al.) are no longer part of
  // the default board — their prompt/tile cards are filtered out so the board
  // is the native product tiles (Tasks / Coding / Analytics / Sales).
  const prompts = allPrompts.filter((p) => !isStudioPackAgent(p.agentId));
  const tiles = allTiles.filter((t) => !isStudioPackAgent(t.agentId));
  const homeIds = useDefaultHomeAgents()?.ids ?? [];
  const pinnedAgentIds = new Set(homeIds);
  const homeWriter = useHomeAgentsWriter();
  const studio = useStudioTools();
  const queryClient = useQueryClient();

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
  // so only loose prompts become standalone grid cards. Native tiles (built-in
  // views like recent conversations) are always candidates; the board's
  // `hidden` set governs whether they're on the board, so they show by default
  // and can be removed / re-added like anything else.
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
    // Native tiles auto-place last so they flow to the bottom — the first fold
    // stays the agent tiles / prompts. A stored position (drag) overrides this.
    ...NATIVE_TILES.map<NativeCandidate>((t) => ({
      kind: "native",
      id: nativeCandidateId(t.id),
      data: t,
    })),
  ];
  const candidatesById = new Map(candidates.map((c) => [c.id, c] as const));

  const layout = useBoardLayout(
    candidates.map((c) => {
      if (c.kind === "native") {
        return {
          id: c.id,
          defaultSize: c.data.defaultSize,
          minSize: c.data.minSize,
          defaultHidden: c.data.defaultHidden,
        };
      }
      return {
        id: c.id,
        defaultSize:
          c.kind === "tile" ? TILE_DEFAULT_SIZE : PROMPT_DEFAULT_SIZE,
        // Agent UI tiles need at least 2 rows to leave the iframe room
        // under the header — at 1 row the embedded UI collapses to a
        // sliver. Prompt tiles can stay at 1×1.
        minSize: c.kind === "tile" ? TILE_MIN_SIZE : undefined,
        pinned: pinnedAgentIds.has(c.data.agentId),
      };
    }),
  );

  // Removing a card. For a pinned agent (managed by the drawer) we drop it
  // from default_home_agents so it actually leaves home — the board's old
  // `hidden` list no longer suppresses pinned agents, so hiding alone would
  // be a no-op. Onboarding/suggestion cards (not pinned) still just hide.
  const removeAgentFromHome = (agentId: string) => {
    void homeWriter
      .apply((ids) => ids.filter((id) => id !== agentId))
      .catch(() => toast.error(t("home.homeGrid.couldntRemoveFromHome")));
  };

  /** Remove a single tile from the agent's `homeTiles` metadata instead
   *  of yanking the whole agent off the board. Only falls back to
   *  removing the agent when this was the last (or only) tile. */
  const removeSingleTile = async (tileData: HomeTileEntry) => {
    const agentTileCount = tiles.filter(
      (t) => t.agentId === tileData.agentId,
    ).length;

    if (agentTileCount <= 1) {
      removeAgentFromHome(tileData.agentId);
      return;
    }

    try {
      const agent = await studio.call("COLLECTION_VIRTUAL_MCP_GET", {
        id: tileData.agentId,
      });
      const item = agent.item;
      if (!item) throw new Error("Agent not found");

      const currentTiles = getHomeTiles(item.metadata?.ui);
      const nextTiles = tileData.tileId
        ? currentTiles.filter((t) => t.tileId !== tileData.tileId)
        : currentTiles.filter(
            (t) =>
              t.connectionId !== tileData.connectionId ||
              t.resourceUri !== tileData.resourceUri,
          );

      await studio.call("COLLECTION_VIRTUAL_MCP_UPDATE", {
        id: tileData.agentId,
        data: {
          metadata: {
            ...(item.metadata ?? {}),
            ui: {
              ...(item.metadata?.ui ?? {}),
              homeTile: null,
              homeTiles: nextTiles,
            },
          },
        },
      });

      void queryClient.invalidateQueries({
        queryKey: KEYS.homeNextActions(org.slug),
      });
    } catch {
      toast.error(t("home.homeGrid.couldntRemoveTile"));
    }
  };

  const removeCandidate = (id: string) => {
    const candidate = candidatesById.get(id);
    if (!candidate) return;

    // Native tiles aren't agents — removing one just drops it from the board
    // (the `hidden` set), and the add-tile drawer can bring it back.
    if (candidate.kind === "native") {
      layout.hideTile(id);
      return;
    }

    if (!pinnedAgentIds.has(candidate.data.agentId)) {
      layout.hideTile(id);
      return;
    }

    if (candidate.kind === "tile") {
      void removeSingleTile(candidate.data);
    } else {
      removeAgentFromHome(candidate.data.agentId);
    }
  };

  const renderTile = (instance: TileInstance) => {
    const candidate = candidatesById.get(instance.id);
    if (!candidate) return null;
    if (candidate.kind === "native") {
      return <NativeTile nativeId={candidate.data.id} />;
    }
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

  if (isLoading || layout.isLoading) return <PromptChipsRowSkeleton />;

  const isEmpty = layout.snapshot.visible.length === 0;
  if (isEmpty && !isEditMode) return null;

  // Everything renders through the same absolute-positioned grid board —
  // prompts as 1×1 tiles, agent UI as larger tiles. One path means the
  // edit-mode drag handle + size/remove menu show up consistently, whether
  // or not the home has an agent-UI tile.
  return (
    <div className="mt-4 flex w-full max-w-7xl flex-col gap-4">
      <TileBoard
        tiles={layout.snapshot.visible}
        isEditMode={isEditMode}
        renderTile={renderTile}
        onMove={layout.moveTile}
        onResize={layout.resizeTile}
        onRemove={removeCandidate}
      />
    </div>
  );
}
