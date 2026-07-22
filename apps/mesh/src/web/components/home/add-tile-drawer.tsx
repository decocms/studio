/**
 * Add-tile drawer — the single place to manage the home board. Lists every
 * virtual MCP in the org and lets you:
 *  - add an agent to the home as a quick-access tile (no prompt/UI needed),
 *  - curate which of an agent's interactive UI tools and prompts are pinned,
 *  - reorder and remove agents already on the home.
 *
 * Home membership + order lives in `organization_settings.default_home_agents`
 * (ordered ids); per-agent curation lives in `metadata.ui.homeTiles` /
 * `metadata.ui.homePrompts`. The home board reads both on the next refetch.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Suspense, useState } from "react";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { getDevAgentIds } from "@/web/lib/agent-capabilities";
import {
  getHomeTiles,
  isDecopilot,
  useProjectContext,
  useVirtualMCPActions,
  useVirtualMCPs,
  type VirtualMCPEntity,
  type VirtualMcpHomeTile,
} from "@decocms/mesh-sdk";
import {
  useDefaultHomeAgents,
  useHomeAgentsWriter,
} from "@/web/hooks/use-organization-settings";
import { AgentPromptList } from "./agent-prompt-list";
import { NativeTilesSection } from "./native-tiles-section";
import { SectionHeader } from "./section-header";
import {
  coerceFormValues,
  seedFormValues,
  toolInputSummary,
} from "./tile-form-values";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { ScrollArea } from "@deco/ui/components/scroll-area.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@deco/ui/components/sheet.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  ChevronDown,
  DotsGrid,
  Loading01,
  Plus,
  SearchSm,
  Settings01,
  X,
} from "@untitledui/icons";
import { toast } from "sonner";
import { getUIResourceUri } from "@/mcp-apps/types.ts";
import { AgentAvatar } from "@/web/components/agent-icon";
import { IntegrationIcon } from "@/web/components/integration-icon";
import {
  ToolInputForm,
  type ToolInputProperty,
} from "@/web/components/tool-input-form";
import { KEYS } from "@/web/lib/query-keys";
import { useStudioTools } from "@/web/lib/studio-tools";
import { toTitleCase } from "@/web/components/chat/message/parts/tool-call-part/utils";
import { ToggleButton } from "./toggle-button";

/** How many agents the home view can actually display — adding past this is
 * blocked so the user never pins something that silently won't show. */
export const HOME_LIMIT = 8;

interface AddTileDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface UITool {
  name: string;
  description?: string;
  resourceUri: string;
  inputSchema?: {
    properties?: Record<string, ToolInputProperty>;
    required?: string[];
  };
}

interface ConnectionUITools {
  id: string;
  title: string;
  icon: string | null;
  uiTools: UITool[];
}

export function AddTileDrawer({ open, onOpenChange }: AddTileDrawerProps) {
  const [search, setSearch] = useState("");

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-md p-0 flex flex-col"
      >
        <SheetHeader className="px-5 py-4 border-b border-border">
          <SheetTitle>Manage home</SheetTitle>
          <SheetDescription>
            Add agents to the home board and pin their interactive UIs or
            prompts.
          </SheetDescription>
          <div className="relative mt-3">
            <SearchSm
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
              aria-hidden
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search agents…"
              className="pl-8 h-8 text-sm"
            />
          </div>
        </SheetHeader>
        <ScrollArea className="flex-1 min-h-0 [&_[data-slot=scroll-area-viewport]>div]:!block">
          <div className="p-3 flex flex-col gap-4">
            <Suspense fallback={<DrawerListSkeleton />}>
              <DrawerBody search={search} />
            </Suspense>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Manages home membership + order. Home state is seeded once from the org
 * settings and then owned locally for the drawer's lifetime so drag-to-reorder
 * is snappy; every mutation also persists to `default_home_agents` and curates
 * per-agent metadata writes go through the same place so the home-next-actions
 * query is fresh by the time the caller resolves.
 */
function useHomeBoard(validIds?: ReadonlySet<string>) {
  const { org } = useProjectContext();
  // Read live from the org-settings cache so we never act on a stale snapshot
  // — seeding local state from this (non-suspense) query risked persisting an
  // empty list on first render and wiping the existing agents.
  const saved = useDefaultHomeAgents();
  const homeIds = saved?.ids ?? [];
  // All membership/order writes go through this serialized, optimistic,
  // rollback-capable writer — see useHomeAgentsWriter for why we never touch
  // the cache or the raw mutation directly here.
  const writer = useHomeAgentsWriter();
  const actions = useVirtualMCPActions();
  const queryClient = useQueryClient();

  const refetchHome = () =>
    queryClient.refetchQueries({
      queryKey: KEYS.homeNextActions(org.slug),
      type: "active",
    });

  const isOnHome = (id: string) => homeIds.includes(id);
  // Ids of deleted agents linger in the stored list (they just drop off the
  // display). Don't let them eat into the limit and block adding agents the
  // user can actually see — count only resolvable ids when we know which exist.
  const liveCount = validIds
    ? homeIds.filter((id) => validIds.has(id)).length
    : homeIds.length;
  const atLimit = liveCount >= HOME_LIMIT;

  const addAgent = (id: string) => {
    if (isOnHome(id) || atLimit) return Promise.resolve();
    return writer.apply((ids) => (ids.includes(id) ? null : [...ids, id]));
  };
  const removeAgent = (id: string) =>
    writer.apply((ids) => ids.filter((x) => x !== id));
  const reorder = (next: string[]) => writer.apply(() => next);

  // Writes an agent's metadata (tile/prompt curation) and makes sure the agent
  // is on the home, then waits for home-next-actions to refetch.
  const saveAgentMetadata = async (
    agent: VirtualMCPEntity,
    nextMetadata: VirtualMCPEntity["metadata"],
  ) => {
    await actions.update.mutateAsync({
      id: agent.id,
      data: { metadata: nextMetadata },
    });
    if (!isOnHome(agent.id) && !atLimit) {
      await writer.apply((ids) =>
        ids.includes(agent.id) ? null : [...ids, agent.id],
      );
    }
    await refetchHome();
  };

  return {
    homeIds,
    isOnHome,
    atLimit,
    addAgent,
    removeAgent,
    reorder,
    saveAgentMetadata,
  };
}

export type HomeBoard = ReturnType<typeof useHomeBoard>;

function DrawerBody({ search }: { search: string }) {
  const agents = useVirtualMCPs({ pageSize: 1000 });
  // Pass the set of existing agents so the limit ignores stale/deleted ids.
  const home = useHomeBoard(new Set(agents.map((a) => a.id)));

  const byId = new Map(agents.map((a) => [a.id, a]));
  const lower = search.trim().toLowerCase();
  const matches = (agent: VirtualMCPEntity) =>
    !lower || agent.title?.toLowerCase().includes(lower);

  // "On home": resolvable agents in home order. Unresolvable ids (deleted
  // agents) just drop off — removing dead entries is the right cleanup.
  const onHome = home.homeIds
    .map((id) => byId.get(id))
    .filter((a): a is VirtualMCPEntity => !!a)
    .filter(matches);

  // Dev agents are reached via the Develop/Live toggle, not added to home.
  const devAgentIds = getDevAgentIds(agents);
  const available = agents
    .filter((a) => a.id && !isDecopilot(a.id))
    .filter((a) => !devAgentIds.has(a.id))
    .filter((a) => !home.isOnHome(a.id))
    .filter(matches)
    .sort((a, b) => (a.title ?? "").localeCompare(b.title ?? ""));

  return (
    <>
      <OnHomeSection home={home} agents={onHome} />
      {!lower && <NativeTilesSection />}
      <AvailableSection home={home} agents={available} hasSearch={!!lower} />
    </>
  );
}

function OnHomeSection({
  home,
  agents,
}: {
  home: HomeBoard;
  agents: VirtualMCPEntity[];
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = home.homeIds;
    const oldIndex = ids.indexOf(active.id as string);
    const newIndex = ids.indexOf(over.id as string);
    if (oldIndex === -1 || newIndex === -1) return;
    home
      .reorder(arrayMove([...ids], oldIndex, newIndex))
      .catch(() => toast.error("Couldn't reorder home — please try again."));
  };

  return (
    <div className="flex flex-col gap-1.5">
      <SectionHeader
        title="On home"
        hint={`${home.homeIds.length}/${HOME_LIMIT}`}
      />
      {agents.length === 0 ? (
        <p className="px-3 py-4 text-center text-xs text-muted-foreground">
          No agents on the home yet.
        </p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={agents.map((a) => a.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="flex flex-col gap-1">
              {agents.map((agent) => (
                <HomeAgentRow key={agent.id} agent={agent} home={home} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}

function AvailableSection({
  home,
  agents,
  hasSearch,
}: {
  home: HomeBoard;
  agents: VirtualMCPEntity[];
  hasSearch: boolean;
}) {
  const [visible, setVisible] = useState(20);
  const shown = agents.slice(0, visible);

  return (
    <div className="flex flex-col gap-1.5">
      <SectionHeader title="Add to home" />
      {agents.length === 0 ? (
        <p className="px-3 py-4 text-center text-xs text-muted-foreground">
          {hasSearch ? "No agents match." : "Every agent is on the home."}
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            {shown.map((agent) => (
              <AvailableAgentRow key={agent.id} agent={agent} home={home} />
            ))}
          </div>
          {agents.length > visible && (
            <button
              type="button"
              onClick={() => setVisible((v) => v + 20)}
              className="mt-1 self-center rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent/40 hover:text-foreground"
            >
              Load more ({agents.length - visible})
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** Tiles/prompts summary line shared by both row variants. */
function useAgentSubtitle(agent: VirtualMCPEntity): string {
  const tileCount = getHomeTiles(agent.metadata?.ui).filter(
    (t) => !!t.resourceUri,
  ).length;
  const curatedPrompts = agent.metadata?.ui?.homePrompts;
  const promptCount = Array.isArray(curatedPrompts)
    ? curatedPrompts.length
    : null;

  const parts: string[] = [];
  if (tileCount > 0)
    parts.push(`${tileCount} tile${tileCount === 1 ? "" : "s"}`);
  if (promptCount !== null && promptCount > 0)
    parts.push(`${promptCount} prompt${promptCount === 1 ? "" : "s"}`);
  if (promptCount === 0) parts.push("prompts off");
  return parts.join(" · ");
}

function HomeAgentRow({
  agent,
  home,
}: {
  agent: VirtualMCPEntity;
  home: HomeBoard;
}) {
  const [expanded, setExpanded] = useState(false);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: agent.id });
  const subtitle = useAgentSubtitle(agent) || "Quick access";
  const expansionId = `home-agent-expansion-${agent.id}`;

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
    zIndex: isDragging ? 100 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "rounded-lg border border-border bg-card",
        isDragging && "shadow-lg",
      )}
    >
      <div className="flex items-center gap-1.5 px-2 py-2.5">
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="shrink-0 text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
          aria-label={`Drag to reorder ${agent.title ?? agent.id}`}
        >
          <DotsGrid size={14} />
        </button>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left outline-none"
          aria-expanded={expanded}
          aria-controls={expansionId}
        >
          <AgentAvatar
            icon={agent.icon}
            name={agent.title ?? agent.id}
            size="sm"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground">
              {agent.title ?? agent.id}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {subtitle}
            </div>
          </div>
          <ChevronDown
            size={16}
            className={cn(
              "shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-180",
            )}
          />
        </button>
        <button
          type="button"
          onClick={() =>
            home
              .removeAgent(agent.id)
              .catch(() =>
                toast.error("Couldn't remove from home — please try again."),
              )
          }
          aria-label={`Remove ${agent.title ?? agent.id} from home`}
          title="Remove from home"
          className="shrink-0 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        >
          <X size={14} />
        </button>
      </div>
      {expanded && (
        <AgentExpansion id={expansionId} agent={agent} home={home} />
      )}
    </div>
  );
}

function AvailableAgentRow({
  agent,
  home,
}: {
  agent: VirtualMCPEntity;
  home: HomeBoard;
}) {
  const [expanded, setExpanded] = useState(false);
  const [adding, setAdding] = useState(false);
  const subtitle = useAgentSubtitle(agent);
  const expansionId = `available-agent-expansion-${agent.id}`;

  const handleAdd = async () => {
    if (home.atLimit) return;
    setAdding(true);
    try {
      await home.addAgent(agent.id);
    } catch {
      toast.error("Couldn't add to home — please try again.");
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none"
          aria-expanded={expanded}
          aria-controls={expansionId}
        >
          <AgentAvatar
            icon={agent.icon}
            name={agent.title ?? agent.id}
            size="sm"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground">
              {agent.title ?? agent.id}
            </div>
            {subtitle && (
              <div className="truncate text-xs text-muted-foreground">
                {subtitle}
              </div>
            )}
          </div>
          <ChevronDown
            size={16}
            className={cn(
              "shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-180",
            )}
          />
        </button>
        <button
          type="button"
          onClick={handleAdd}
          disabled={adding || home.atLimit}
          aria-label="Add to home"
          title={
            home.atLimit
              ? `Home is full (${HOME_LIMIT}) — remove an agent first`
              : "Add to home"
          }
          className="shrink-0 inline-flex size-7 items-center justify-center rounded-md bg-foreground text-background text-xs hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {adding ? (
            <Loading01 size={12} className="animate-spin" />
          ) : (
            <Plus size={14} />
          )}
        </button>
      </div>
      {expanded && (
        <AgentExpansion id={expansionId} agent={agent} home={home} />
      )}
    </div>
  );
}

/** Expanded body — pick which UI tools and prompts of the agent are pinned.
 * Toggling any of these also pulls the agent onto the home (via the home
 * board's saveAgentMetadata). */
function AgentExpansion({
  id,
  agent,
  home,
}: {
  id: string;
  agent: VirtualMCPEntity;
  home: HomeBoard;
}) {
  const pinnedTiles = getHomeTiles(agent.metadata?.ui);
  const connectionIds = (agent.connections ?? [])
    .map((c) => c.connection_id)
    .sort();
  const curatedPrompts = agent.metadata?.ui?.homePrompts;

  return (
    <div
      id={id}
      className="border-t border-border px-3 py-2 flex flex-col gap-3"
    >
      <AgentToolList
        agent={agent}
        home={home}
        connectionIds={connectionIds}
        pinnedTiles={pinnedTiles}
      />
      <Suspense fallback={<PromptListSkeleton />}>
        <AgentPromptList
          agent={agent}
          home={home}
          curated={curatedPrompts ?? null}
        />
      </Suspense>
    </div>
  );
}

function PromptListSkeleton() {
  return (
    <div className="flex flex-col gap-2 py-1">
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-2/3" />
    </div>
  );
}

function AgentToolList({
  agent,
  home,
  connectionIds,
  pinnedTiles,
}: {
  agent: VirtualMCPEntity;
  home: HomeBoard;
  connectionIds: string[];
  pinnedTiles: VirtualMcpHomeTile[];
}) {
  const studio = useStudioTools();

  const { data, isLoading } = useQuery({
    queryKey: KEYS.projectConnectionDetails(agent.id, connectionIds),
    enabled: connectionIds.length > 0,
    queryFn: async (): Promise<ConnectionUITools[]> => {
      const results = await Promise.all(
        connectionIds.map(async (connId) => {
          try {
            const { item } = await studio.call("COLLECTION_CONNECTIONS_GET", {
              id: connId,
            });
            const uiTools: UITool[] = (item?.tools ?? []).flatMap((t) => {
              const resourceUri = getUIResourceUri(t._meta);
              if (!resourceUri) return [];
              return [
                {
                  name: t.name,
                  description: t.description,
                  resourceUri,
                  inputSchema: t.inputSchema as UITool["inputSchema"],
                },
              ];
            });
            return {
              id: connId,
              title: item?.title ?? connId,
              icon: item?.icon ?? null,
              uiTools,
            };
          } catch {
            return { id: connId, title: connId, icon: null, uiTools: [] };
          }
        }),
      );
      return results.filter((c) => c.uiTools.length > 0);
    },
  });

  if (connectionIds.length === 0) return null;
  if (isLoading) {
    return (
      <div className="flex flex-col gap-1 py-0.5">
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-2/3" />
      </div>
    );
  }
  if (!data || data.length === 0) return null;

  // Build a lookup from connectionId+toolName to the UITool definition
  // so pinned tile rows can resolve their tool's inputSchema. Keyed by
  // toolName (not resourceUri) because multiple tools can share the same
  // resourceUri (e.g. two VTEX tools both point to ui://vtex/dashboard).
  const toolByKey = new Map<
    string,
    { conn: ConnectionUITools; tool: UITool }
  >();
  for (const conn of data) {
    for (const tool of conn.uiTools) {
      toolByKey.set(`${conn.id}:${tool.name}`, { conn, tool });
    }
  }

  // Resolve a pinned tile to its UITool definition. Prefers toolName
  // (new tiles), falls back to resourceUri match (legacy tiles).
  const resolveToolForTile = (
    tile: VirtualMcpHomeTile,
  ): { conn: ConnectionUITools; tool: UITool } | undefined => {
    if (tile.toolName && tile.connectionId) {
      return toolByKey.get(`${tile.connectionId}:${tile.toolName}`);
    }
    // Legacy tiles without toolName — find first tool matching resourceUri.
    for (const [, entry] of toolByKey) {
      if (
        entry.conn.id === tile.connectionId &&
        entry.tool.resourceUri === tile.resourceUri
      ) {
        return entry;
      }
    }
    return undefined;
  };

  const hasPinned = pinnedTiles.some((tile) => !!resolveToolForTile(tile));

  return (
    <div className="flex flex-col gap-2">
      {hasPinned && (
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground px-2">
            Pinned tiles
          </span>
          {pinnedTiles.map((tile) => {
            const match = resolveToolForTile(tile);
            if (!match) return null;
            return (
              <PinnedTileRow
                key={
                  tile.tileId ??
                  `${tile.connectionId}:${tile.resourceUri}:${tile.toolName}`
                }
                agent={agent}
                home={home}
                connection={match.conn}
                tool={match.tool}
                tile={tile}
              />
            );
          })}
        </div>
      )}
      <div className="flex flex-col gap-0.5">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground px-2">
          Add tile
        </span>
        {data.map((conn) =>
          conn.uiTools.map((tool) => (
            <AddToolRow
              key={`add:${conn.id}:${tool.name}`}
              agent={agent}
              home={home}
              connection={conn}
              tool={tool}
            />
          )),
        )}
      </div>
    </div>
  );
}

/** Builds the agent metadata patch for a new set of home tiles. Shared by the
 * pinned-tile remove/save flows and the add-tile flow. */
function withHomeTiles(
  agent: VirtualMCPEntity,
  tiles: VirtualMcpHomeTile[],
): VirtualMCPEntity["metadata"] {
  return {
    ...(agent.metadata ?? {}),
    ui: {
      ...(agent.metadata?.ui ?? {}),
      homeTile: null,
      homeTiles: tiles,
    },
  };
}

/** Runs a home-tile mutation, logging and toasting on failure. Shared by the
 * pinned-tile remove/save flows and the add-tile flow. */
async function runHomeTileAction(action: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    console.error(`[home-tiles] failed to ${action} tile`, err);
    toast.error("Couldn't update home — please try again.");
  }
}

/** Coerces the form values against the tool's schema, toasting and returning
 * `undefined` on an invalid field. Shared by the pinned-tile save flow and the
 * add-tile flow — both build the same `toolInput` from the same form. */
function resolveToolInput(
  formValues: Record<string, unknown>,
  properties: Record<string, ToolInputProperty> | undefined,
  required: string[] | undefined,
): { toolInput?: Record<string, unknown> } | undefined {
  if (!properties || Object.keys(properties).length === 0) return {};
  const coerced = coerceFormValues(formValues, properties, required);
  if (!coerced) {
    toast.error("Invalid value in one of the fields — please fix it.");
    return undefined;
  }
  return Object.keys(coerced).length > 0 ? { toolInput: coerced } : {};
}

/** Shared config-form footer for a tile's tool-input schema — used by both
 * the pinned-tile edit flow and the add-tile flow, which only differ in the
 * cancel behavior and the submit button's label/handler. */
function TileConfigForm({
  properties,
  required,
  values,
  onChange,
  onCancel,
  onSubmit,
  submitting,
  submitLabel,
}: {
  properties: Record<string, ToolInputProperty>;
  required?: string[];
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  onCancel: () => void;
  onSubmit: () => void;
  submitting: boolean;
  submitLabel: string;
}) {
  return (
    <div className="px-3 pb-2 pt-1 flex flex-col gap-2">
      <ToolInputForm
        properties={properties}
        required={required}
        values={values}
        onChange={onChange}
      />
      <div className="flex items-center gap-2 justify-end">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          className="h-7 text-xs"
          disabled={submitting}
          onClick={onSubmit}
        >
          {submitting ? (
            <Loading01 size={12} className="animate-spin" />
          ) : (
            submitLabel
          )}
        </Button>
      </div>
    </div>
  );
}

/** Row for a pinned tile instance — shows a summary, gear to edit, minus to remove. */
function PinnedTileRow({
  agent,
  home,
  connection,
  tool,
  tile,
}: {
  agent: VirtualMCPEntity;
  home: HomeBoard;
  connection: ConnectionUITools;
  tool: UITool;
  tile: VirtualMcpHomeTile;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const hasProps =
    tool.inputSchema?.properties &&
    Object.keys(tool.inputSchema.properties).length > 0;

  const [formValues, setFormValues] = useState<Record<string, unknown>>(() =>
    seedFormValues(tile.toolInput, tool.inputSchema?.properties),
  );

  const handleRemove = async () => {
    setSubmitting(true);
    await runHomeTileAction("remove", async () => {
      const baseTiles = getHomeTiles(agent.metadata?.ui);
      const nextTiles = tile.tileId
        ? baseTiles.filter((t) => t.tileId !== tile.tileId)
        : baseTiles.filter((t) => t !== tile);
      await home.saveAgentMetadata(agent, withHomeTiles(agent, nextTiles));
      setShowForm(false);
    });
    setSubmitting(false);
  };

  const handleSave = async () => {
    const resolved = resolveToolInput(
      formValues,
      tool.inputSchema?.properties,
      tool.inputSchema?.required,
    );
    if (!resolved) return;
    const { toolInput } = resolved;

    setSubmitting(true);
    await runHomeTileAction("save", async () => {
      const baseTiles = getHomeTiles(agent.metadata?.ui);
      const nextTiles = baseTiles.map((t) => {
        const isMatch = tile.tileId ? t.tileId === tile.tileId : t === tile;
        if (!isMatch) return t;
        return {
          ...t,
          toolInput,
        };
      });
      await home.saveAgentMetadata(agent, withHomeTiles(agent, nextTiles));
      setShowForm(false);
    });
    setSubmitting(false);
  };

  const summary = toolInputSummary(tile.toolInput);

  return (
    <div className="flex flex-col rounded-md bg-accent/20">
      <div className="flex items-center gap-2.5 px-2 py-1">
        <IntegrationIcon
          icon={connection.icon}
          name={connection.title}
          size="xs"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-foreground">
            {toTitleCase(tool.name)}
          </div>
          {summary && (
            <div className="truncate text-[10px] text-muted-foreground font-mono">
              {summary}
            </div>
          )}
        </div>
        {hasProps && (
          <button
            type="button"
            onClick={() => setShowForm((v) => !v)}
            aria-label="Configure tile props"
            title="Configure tile props"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/60"
          >
            <Settings01 size={14} />
          </button>
        )}
        <ToggleButton
          isPinned
          submitting={submitting}
          onClick={handleRemove}
          label="Remove from home"
        />
      </div>
      {showForm && hasProps && tool.inputSchema?.properties && (
        <TileConfigForm
          properties={tool.inputSchema.properties}
          required={tool.inputSchema.required}
          values={formValues}
          onChange={(key, value) =>
            setFormValues((prev) => ({ ...prev, [key]: value }))
          }
          onCancel={() => setShowForm(false)}
          onSubmit={handleSave}
          submitting={submitting}
          submitLabel="Save"
        />
      )}
    </div>
  );
}

/** Row to add a new tile instance of a tool. Always creates a fresh tile
 * with a unique tileId so the same tool can be pinned multiple times with
 * different toolInput. */
function AddToolRow({
  agent,
  home,
  connection,
  tool,
}: {
  agent: VirtualMCPEntity;
  home: HomeBoard;
  connection: ConnectionUITools;
  tool: UITool;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const hasProps =
    tool.inputSchema?.properties &&
    Object.keys(tool.inputSchema.properties).length > 0;
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});

  const handleAdd = async () => {
    // If the tool has configurable props, show the form first.
    if (hasProps && !showForm) {
      setShowForm(true);
      return;
    }

    if (!home.isOnHome(agent.id) && home.atLimit) {
      toast.error(`Home is full (${HOME_LIMIT}) — remove an agent first`);
      return;
    }

    await saveTile();
  };

  const saveTile = async () => {
    const resolved = resolveToolInput(
      formValues,
      tool.inputSchema?.properties,
      tool.inputSchema?.required,
    );
    if (!resolved) return;
    const { toolInput } = resolved;

    setSubmitting(true);
    await runHomeTileAction("add", async () => {
      const baseTiles = getHomeTiles(agent.metadata?.ui);
      const nextTiles = [
        ...baseTiles,
        {
          tileId: crypto.randomUUID(),
          connectionId: connection.id,
          resourceUri: tool.resourceUri,
          toolName: tool.name,
          ...(toolInput ? { toolInput } : {}),
        },
      ];
      await home.saveAgentMetadata(agent, withHomeTiles(agent, nextTiles));
      setShowForm(false);
      setFormValues({});
    });
    setSubmitting(false);
  };

  return (
    <div className="flex flex-col rounded-md hover:bg-accent/40">
      <div className="flex items-center gap-2.5 px-2 py-1">
        <IntegrationIcon
          icon={connection.icon}
          name={connection.title}
          size="xs"
        />
        <div className="min-w-0 flex-1 truncate text-sm text-foreground">
          {toTitleCase(tool.name)}
        </div>
        <ToggleButton
          isPinned={false}
          submitting={submitting}
          onClick={handleAdd}
          label="Add to home"
        />
      </div>
      {showForm && hasProps && tool.inputSchema?.properties && (
        <TileConfigForm
          properties={tool.inputSchema.properties}
          required={tool.inputSchema.required}
          values={formValues}
          onChange={(key, value) =>
            setFormValues((prev) => ({ ...prev, [key]: value }))
          }
          onCancel={() => {
            setShowForm(false);
            setFormValues({});
          }}
          onSubmit={saveTile}
          submitting={submitting}
          submitLabel="Pin"
        />
      )}
    </div>
  );
}

function DrawerListSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-2">
      {Array.from({ length: 4 }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-lg border border-border p-2.5"
        >
          <Skeleton className="size-8 rounded-md" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-2.5 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}
