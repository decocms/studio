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
import {
  getHomeTiles,
  isDecopilot,
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
  useVirtualMCPActions,
  useVirtualMCPs,
  type VirtualMCPEntity,
} from "@decocms/mesh-sdk";
import {
  useDefaultHomeAgents,
  useHomeAgentsWriter,
} from "@/web/hooks/use-organization-settings";
import { useHomeNextActions } from "@/web/hooks/use-home-next-actions";
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
  Minus,
  Plus,
  SearchSm,
  X,
} from "@untitledui/icons";
import { toast } from "sonner";
import { getUIResourceUri } from "@/mcp-apps/types.ts";
import { AgentAvatar } from "@/web/components/agent-icon";
import { IntegrationIcon } from "@/web/components/integration-icon";
import { KEYS } from "@/web/lib/query-keys";
import { unwrapToolResult } from "@/web/lib/unwrap-tool-result";
import { toTitleCase } from "@/web/components/chat/message/parts/tool-call-part/utils";

/** How many agents the home view can actually display — adding past this is
 * blocked so the user never pins something that silently won't show. */
const HOME_LIMIT = 8;

interface AddTileDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface UITool {
  name: string;
  description?: string;
  resourceUri: string;
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
        <ScrollArea className="flex-1 min-h-0">
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

type HomeBoard = ReturnType<typeof useHomeBoard>;

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

  const available = agents
    .filter((a) => a.id && !isDecopilot(a.id))
    .filter((a) => !home.isOnHome(a.id))
    .filter(matches)
    .sort((a, b) => (a.title ?? "").localeCompare(b.title ?? ""));

  return (
    <>
      <OnHomeSection home={home} agents={onHome} />
      <AvailableSection home={home} agents={available} hasSearch={!!lower} />
    </>
  );
}

function SectionHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex items-center justify-between px-1">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
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
      {expanded && <AgentExpansion agent={agent} home={home} />}
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
      {expanded && <AgentExpansion agent={agent} home={home} />}
    </div>
  );
}

/** Expanded body — pick which UI tools and prompts of the agent are pinned.
 * Toggling any of these also pulls the agent onto the home (via the home
 * board's saveAgentMetadata). */
function AgentExpansion({
  agent,
  home,
}: {
  agent: VirtualMCPEntity;
  home: HomeBoard;
}) {
  const pinned = getHomeTiles(agent.metadata?.ui);
  const connectionIds = (agent.connections ?? [])
    .map((c) => c.connection_id)
    .sort();
  const curatedPrompts = agent.metadata?.ui?.homePrompts;

  return (
    <div className="border-t border-border px-3 py-2 flex flex-col gap-3">
      <AgentToolList
        agent={agent}
        home={home}
        connectionIds={connectionIds}
        pinnedResourceUris={new Set(pinned.map((t) => t.resourceUri))}
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
  pinnedResourceUris,
}: {
  agent: VirtualMCPEntity;
  home: HomeBoard;
  connectionIds: string[];
  pinnedResourceUris: Set<string>;
}) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const { data, isLoading } = useQuery({
    queryKey: KEYS.projectConnectionDetails(agent.id, connectionIds),
    enabled: connectionIds.length > 0,
    queryFn: async (): Promise<ConnectionUITools[]> => {
      const results = await Promise.all(
        connectionIds.map(async (connId) => {
          try {
            const result = await client.callTool({
              name: "COLLECTION_CONNECTIONS_GET",
              arguments: { id: connId },
            });
            const { item } = unwrapToolResult<{
              item: {
                title?: string;
                icon?: string | null;
                tools?: Array<{
                  name: string;
                  description?: string;
                  _meta?: Record<string, unknown>;
                }> | null;
              } | null;
            }>(result);
            const uiTools: UITool[] = (item?.tools ?? []).flatMap((t) => {
              const resourceUri = getUIResourceUri(t._meta);
              if (!resourceUri) return [];
              return [
                { name: t.name, description: t.description, resourceUri },
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
  // Quietly hide the section when nothing relevant exists — the prompt
  // list below still shows up.
  if (!data || data.length === 0) return null;

  return (
    <div className="flex flex-col gap-0.5">
      {data.map((conn) =>
        conn.uiTools.map((tool) => (
          <ToolRow
            key={`${conn.id}:${tool.name}`}
            agent={agent}
            home={home}
            connection={conn}
            tool={tool}
            isPinned={pinnedResourceUris.has(tool.resourceUri)}
          />
        )),
      )}
    </div>
  );
}

function ToolRow({
  agent,
  home,
  connection,
  tool,
  isPinned,
}: {
  agent: VirtualMCPEntity;
  home: HomeBoard;
  connection: ConnectionUITools;
  tool: UITool;
  isPinned: boolean;
}) {
  const [submitting, setSubmitting] = useState(false);

  const handleClick = async () => {
    // Pinning a tile pulls the agent onto the home; block when full.
    if (!isPinned && !home.isOnHome(agent.id) && home.atLimit) {
      toast.error(`Home is full (${HOME_LIMIT}) — remove an agent first`);
      return;
    }
    setSubmitting(true);
    try {
      const baseTiles = getHomeTiles(agent.metadata?.ui);
      const nextTiles = isPinned
        ? baseTiles.filter((t) => t.resourceUri !== tool.resourceUri)
        : [
            ...baseTiles,
            { connectionId: connection.id, resourceUri: tool.resourceUri },
          ];
      const nextMetadata = {
        ...(agent.metadata ?? {}),
        ui: {
          ...(agent.metadata?.ui ?? {}),
          // Clear the legacy slot — `homeTiles` is now canonical.
          homeTile: null,
          homeTiles: nextTiles,
        },
      };
      await home.saveAgentMetadata(agent, nextMetadata);
    } catch (err) {
      console.error("[home-tiles] failed to toggle tile", err);
      toast.error("Couldn't update home — please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex items-center gap-2.5 rounded-md px-2 py-1 hover:bg-accent/40">
      <IntegrationIcon
        icon={connection.icon}
        name={connection.title}
        size="xs"
      />
      <div className="min-w-0 flex-1 truncate text-sm text-foreground">
        {toTitleCase(tool.name)}
      </div>
      <ToggleButton
        isPinned={isPinned}
        submitting={submitting}
        onClick={handleClick}
        label={isPinned ? "Remove from home" : "Add to home"}
      />
    </div>
  );
}

function ToggleButton({
  isPinned,
  submitting,
  onClick,
  label,
}: {
  isPinned: boolean;
  submitting: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={submitting}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-xs transition-colors disabled:opacity-50 disabled:cursor-progress",
        isPinned
          ? "text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          : "bg-foreground text-background hover:opacity-90",
      )}
    >
      {submitting ? (
        <Loading01 size={12} className="animate-spin" />
      ) : isPinned ? (
        <Minus size={14} />
      ) : (
        <Plus size={14} />
      )}
    </button>
  );
}

interface AgentPrompt {
  name: string;
  title?: string;
  description?: string;
}

/**
 * Lists every prompt the agent's gateway exposes. Pin/unpin writes to
 * `metadata.ui.homePrompts` — when that field is null/absent the home
 * surfaces all prompts (default), when it's an array (even empty) the
 * BE honors that list verbatim.
 */
function AgentPromptList({
  agent,
  home,
  curated,
}: {
  agent: VirtualMCPEntity;
  home: HomeBoard;
  curated: string[] | null;
}) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: agent.id,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const { data, isLoading, error } = useQuery({
    queryKey: KEYS.agentPrompts(org.id, agent.id),
    queryFn: async (): Promise<AgentPrompt[]> => {
      const { prompts } = await client.listPrompts();
      return prompts.map((p) => ({
        name: p.name,
        title: p.title,
        description: p.description,
      }));
    },
    staleTime: 30_000,
    retry: false,
  });

  // Studio Pack agents and others whose gateway doesn't surface prompts
  // via `prompts/list` still emit them through the home-next-actions
  // endpoint (checklist items, etc). Merge that as a fallback source.
  const homeNextActions = useHomeNextActions(org.slug);
  const fromHome: AgentPrompt[] = homeNextActions.prompts
    .filter((p) => p.agentId === agent.id && p.promptName)
    .map((p) => ({
      name: p.promptName,
      title: p.title,
      description: p.description,
    }));

  const merged: AgentPrompt[] = [...(data ?? [])];
  for (const p of fromHome) {
    if (!merged.some((m) => m.name === p.name)) merged.push(p);
  }

  if (isLoading && fromHome.length === 0) {
    return (
      <div className="flex flex-col gap-1">
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-2/3" />
      </div>
    );
  }
  if (error && fromHome.length === 0) {
    console.error("[home-tiles] listPrompts failed for agent", agent.id, error);
    return null;
  }
  if (merged.length === 0) {
    return null;
  }

  // When `homePrompts` is null/absent, all prompts are surfaced — every
  // row reads as pinned so the default "all on" state is conveyed by
  // the buttons themselves.
  const pinnedNames = new Set(curated ?? merged.map((p) => p.name));

  return (
    <div className="flex flex-col gap-0.5">
      {merged.map((prompt) => (
        <PromptRow
          key={prompt.name}
          agent={agent}
          home={home}
          prompt={prompt}
          allPromptNames={merged.map((p) => p.name)}
          isPinned={pinnedNames.has(prompt.name)}
        />
      ))}
    </div>
  );
}

function PromptRow({
  agent,
  home,
  prompt,
  allPromptNames,
  isPinned,
}: {
  agent: VirtualMCPEntity;
  home: HomeBoard;
  prompt: AgentPrompt;
  /** Every prompt the agent exposes — used when transitioning from
   *  "all (uncurated)" to "curated" so we don't drop everything. */
  allPromptNames: string[];
  isPinned: boolean;
}) {
  const [submitting, setSubmitting] = useState(false);

  const handleClick = async () => {
    if (!isPinned && !home.isOnHome(agent.id) && home.atLimit) {
      toast.error(`Home is full (${HOME_LIMIT}) — remove an agent first`);
      return;
    }
    setSubmitting(true);
    try {
      // Compute next `homePrompts`. Three states:
      //  - uncurated (null) + Remove → keep every prompt except this one
      //  - curated array + Add → append name
      //  - curated array + Remove → filter out name
      const current = agent.metadata?.ui?.homePrompts;
      let nextHomePrompts: string[];
      if (!Array.isArray(current)) {
        nextHomePrompts = isPinned
          ? allPromptNames.filter((n) => n !== prompt.name)
          : allPromptNames; // unreachable: pinned=true in uncurated mode
      } else {
        nextHomePrompts = isPinned
          ? current.filter((n) => n !== prompt.name)
          : [...current, prompt.name];
      }
      const nextMetadata = {
        ...(agent.metadata ?? {}),
        ui: {
          ...(agent.metadata?.ui ?? {}),
          homePrompts: nextHomePrompts,
        },
      };
      await home.saveAgentMetadata(agent, nextMetadata);
    } catch (err) {
      console.error("[home-tiles] failed to toggle prompt", err);
      toast.error("Couldn't update home — please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex items-center gap-2.5 rounded-md px-2 py-1 hover:bg-accent/40">
      <div className="min-w-0 flex-1 truncate text-sm text-foreground">
        {prompt.title ?? toTitleCase(prompt.name)}
      </div>
      <ToggleButton
        isPinned={isPinned}
        submitting={submitting}
        onClick={handleClick}
        label={isPinned ? "Remove from home" : "Add to home"}
      />
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
