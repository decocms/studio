/**
 * Add-tile drawer. Lists every virtual MCP in the org with its
 * interactive UI tools and prompts; toggling a row writes
 * `metadata.ui.homeTiles` / `metadata.ui.homePrompts` and the home
 * board picks them up on the next refetch.
 */

import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { sleep } from "@decocms/std";
import { Suspense, useState } from "react";
import {
  createMCPClient,
  getHomeTiles,
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
  useVirtualMCPActions,
  useVirtualMCPs,
  type VirtualMCPEntity,
} from "@decocms/mesh-sdk";
import {
  useDefaultHomeAgents,
  useUpdateDefaultHomeAgents,
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
  Check,
  ChevronDown,
  Loading01,
  Minus,
  Plus,
  SearchSm,
} from "@untitledui/icons";
import { getUIResourceUri } from "@/mcp-apps/types.ts";
import { AgentAvatar } from "@/web/components/agent-icon";
import { IntegrationIcon } from "@/web/components/integration-icon";
import { KEYS } from "@/web/lib/query-keys";
import { unwrapToolResult } from "@/web/lib/unwrap-tool-result";
import { toTitleCase } from "@/web/components/chat/message/parts/tool-call-part/utils";

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
          <SheetTitle>Add tile to home</SheetTitle>
          <SheetDescription>
            Pin any agent's interactive UI or prompts to the home board.
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
        <ScrollArea className="flex-1">
          <div className="p-3 flex flex-col gap-1">
            <Suspense fallback={<DrawerListSkeleton />}>
              <AgentsList search={search} />
            </Suspense>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

function AgentsList({ search }: { search: string }) {
  const { org } = useProjectContext();
  const agents = useVirtualMCPs();
  const sorted = [...agents].sort((a, b) =>
    (a.title ?? "").localeCompare(b.title ?? ""),
  );

  // Probe each agent's gateway + connections eagerly so we can hide ones
  // with no addable content. Empty agents (no UI tools and no prompts)
  // would just be a row that opens to nothing — pure noise.
  const { summaries, allSettled } = useAgentSummaries(sorted);

  // Hold the skeleton until every probe lands so the list renders
  // already-filtered — no flash of all agents collapsing to a subset.
  // A deadline guards against one hung gateway pinning the whole list:
  // once it trips we render what we have and let stragglers prune as
  // they resolve (the lesser of two evils).
  const deadlineReached = useProbeDeadline(org.id, 2500);
  const ready = allSettled || deadlineReached;

  const lower = search.trim().toLowerCase();
  const filtered = sorted.filter((agent) => {
    if (lower && !agent.title?.toLowerCase().includes(lower)) return false;
    // Agents the user has already customised must remain reachable
    // here — that's the only place to undo the customisation. A curated
    // `homePrompts` (including the empty-array "prompts off" state) or
    // any pinned tile means the row stays, even if the probe says
    // empty (e.g. gateway briefly unreachable).
    const hasCuratedPrompts = Array.isArray(agent.metadata?.ui?.homePrompts);
    const hasPinnedTile = getHomeTiles(agent.metadata?.ui).length > 0;
    if (hasCuratedPrompts || hasPinnedTile) return true;
    const summary = summaries.get(agent.id);
    // Until the probe resolves, show the agent — don't flash an empty
    // list while data is loading. Once resolved, hide rows where both
    // sides are empty.
    if (summary && !summary.hasUITool && !summary.hasPrompts) return false;
    return true;
  });

  if (!ready) {
    return <DrawerListSkeleton />;
  }
  if (filtered.length === 0) {
    return (
      <p className="px-3 py-8 text-center text-sm text-muted-foreground">
        {lower ? "No agents match." : "Nothing to pin yet."}
      </p>
    );
  }
  return (
    <>
      {filtered.map((agent) => (
        <AgentRow key={agent.id} agent={agent} />
      ))}
    </>
  );
}

interface AgentSummary {
  hasUITool: boolean;
  hasPrompts: boolean;
}

/**
 * Probes each agent for any `ui://` resource and any gateway prompt so
 * the drawer can hide agents with nothing to pin. Studio Pack agents,
 * whose gateway `listPrompts` can be empty even when checklist items
 * exist, fall back to the home-next-actions response.
 */
function useProbeDeadline(orgId: string, ms: number): boolean {
  const { data } = useQuery({
    queryKey: KEYS.agentSummaryDeadline(orgId, ms),
    queryFn: () => sleep(ms).then(() => true),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data === true;
}

function useAgentSummaries(agents: VirtualMCPEntity[]): {
  summaries: Map<string, AgentSummary | undefined>;
  allSettled: boolean;
} {
  const { org } = useProjectContext();
  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const homeNextActions = useHomeNextActions(org.slug);
  const promptedAgentIds = new Set(
    homeNextActions.prompts.map((p) => p.agentId),
  );

  const results = useQueries({
    queries: agents.map((agent) => ({
      queryKey: KEYS.agentSummary(org.id, agent.id),
      queryFn: async (): Promise<AgentSummary> => {
        const connectionIds = (agent.connections ?? []).map(
          (c) => c.connection_id,
        );
        // Walk connections sequentially and bail at the first UI tool —
        // no need to scan the rest of the list.
        let hasUITool = false;
        for (const connId of connectionIds) {
          try {
            const result = await selfClient.callTool({
              name: "COLLECTION_CONNECTIONS_GET",
              arguments: { id: connId },
            });
            const { item } = unwrapToolResult<{
              item: {
                tools?: Array<{ _meta?: Record<string, unknown> }> | null;
              } | null;
            }>(result);
            if ((item?.tools ?? []).some((t) => getUIResourceUri(t._meta))) {
              hasUITool = true;
              break;
            }
          } catch {
            // Skip unreachable connections — they shouldn't gate the
            // agent showing up.
          }
        }

        let hasPrompts = false;
        try {
          const gateway = await createMCPClient({
            connectionId: agent.id,
            orgId: org.id,
            orgSlug: org.slug,
          });
          try {
            const { prompts } = await gateway.listPrompts();
            hasPrompts = prompts.length > 0;
          } finally {
            await gateway.close();
          }
        } catch {
          // ignore — fall through to the home-next-actions fallback below
        }

        return { hasUITool, hasPrompts };
      },
      staleTime: 60_000,
      retry: false,
    })),
  });

  const out = new Map<string, AgentSummary | undefined>();
  agents.forEach((agent, i) => {
    const raw = results[i]?.data;
    if (!raw) {
      out.set(agent.id, undefined);
      return;
    }
    // If home-next-actions surfaces prompts for this agent (Studio Pack
    // checklist items, etc.) treat that as hasPrompts even if the
    // gateway probe didn't.
    out.set(agent.id, {
      hasUITool: raw.hasUITool,
      hasPrompts: raw.hasPrompts || promptedAgentIds.has(agent.id),
    });
  });
  // `isPending` stays false once a query resolves, including background
  // refetches of stale data — so a warm cache reports settled instantly.
  const allSettled = results.every((r) => !r.isPending);
  return { summaries: out, allSettled };
}

function AgentRow({ agent }: { agent: VirtualMCPEntity }) {
  const [expanded, setExpanded] = useState(false);
  const pinned = getHomeTiles(agent.metadata?.ui);
  const tileCount = pinned.filter((t) => !!t.resourceUri).length;
  // `homePrompts: null/undefined` = all prompts (count unknown without
  // fetching). We only show an explicit count when the user has curated
  // a list — otherwise the subtitle reads "all prompts on" (the default).
  const curatedPrompts = agent.metadata?.ui?.homePrompts;
  const promptCount = Array.isArray(curatedPrompts)
    ? curatedPrompts.length
    : null;
  const connectionIds = (agent.connections ?? [])
    .map((c) => c.connection_id)
    .sort();

  // Tight subtitle — only show counts that are non-default. Default state
  // (nothing curated) is implied; no need to spell it out.
  const subtitleParts: string[] = [];
  if (tileCount > 0)
    subtitleParts.push(`${tileCount} tile${tileCount === 1 ? "" : "s"}`);
  if (promptCount !== null && promptCount > 0)
    subtitleParts.push(`${promptCount} prompt${promptCount === 1 ? "" : "s"}`);
  if (promptCount === 0) subtitleParts.push("prompts off");
  const subtitle = subtitleParts.join(" · ");

  const hasAnyPinned = tileCount > 0 || (promptCount ?? 0) > 0;

  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-accent/40 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
        {hasAnyPinned && (
          <span
            className="inline-flex size-4 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400"
            aria-label="Pinned to home"
          >
            <Check size={10} />
          </span>
        )}
        <ChevronDown
          size={16}
          className={cn(
            "text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded && (
        <div className="border-t border-border px-3 py-2 flex flex-col gap-3">
          <AgentToolList
            agent={agent}
            connectionIds={connectionIds}
            pinnedResourceUris={new Set(pinned.map((t) => t.resourceUri))}
          />
          <Suspense fallback={<PromptListSkeleton />}>
            <AgentPromptList agent={agent} curated={curatedPrompts ?? null} />
          </Suspense>
        </div>
      )}
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
  connectionIds,
  pinnedResourceUris,
}: {
  agent: VirtualMCPEntity;
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
  // list below still shows up. Avoids a noisy "no UI tools" sentence in
  // the common case of prompt-only agents.
  if (!data || data.length === 0) return null;

  return (
    <div className="flex flex-col gap-0.5">
      {data.map((conn) =>
        conn.uiTools.map((tool) => (
          <ToolRow
            key={`${conn.id}:${tool.name}`}
            agent={agent}
            connection={conn}
            tool={tool}
            isPinned={pinnedResourceUris.has(tool.resourceUri)}
          />
        )),
      )}
    </div>
  );
}

/**
 * Saves an updated `metadata` for `agent`, then makes sure the agent is
 * in `default_home_agents` (tiles/prompts only surface there) and the
 * home-next-actions query is fresh by the time the caller resolves. The
 * two writers below (ToolRow, PromptRow) only differ in what metadata
 * they build — everything around it is shared.
 */
function usePinToHome(agent: VirtualMCPEntity) {
  const { org } = useProjectContext();
  const actions = useVirtualMCPActions();
  const defaultHome = useDefaultHomeAgents();
  const updateDefaultHome = useUpdateDefaultHomeAgents();
  const queryClient = useQueryClient();

  const save = async (nextMetadata: VirtualMCPEntity["metadata"]) => {
    await actions.update.mutateAsync({
      id: agent.id,
      data: { metadata: nextMetadata },
    });
    const currentIds = defaultHome?.ids ?? [];
    if (!currentIds.includes(agent.id)) {
      await updateDefaultHome.mutateAsync({
        ids: [...currentIds, agent.id],
      });
    }
    // The collection mutation invalidates virtual-mcp queries, but
    // `home-next-actions` is its own key — wait for the refetch so
    // callers can rely on fresh data before closing UI.
    await queryClient.refetchQueries({
      queryKey: KEYS.homeNextActions(org.slug),
      type: "active",
    });
  };

  return { save };
}

function ToolRow({
  agent,
  connection,
  tool,
  isPinned,
}: {
  agent: VirtualMCPEntity;
  connection: ConnectionUITools;
  tool: UITool;
  isPinned: boolean;
}) {
  const { save } = usePinToHome(agent);
  const [submitting, setSubmitting] = useState(false);

  const handleClick = async () => {
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
      await save(nextMetadata);
    } catch (err) {
      // Mutation hooks already toast on error; log so the cause shows
      // up in devtools instead of being swallowed.
      console.error("[home-tiles] failed to toggle tile", err);
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
  curated,
}: {
  agent: VirtualMCPEntity;
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
  // endpoint (checklist items, etc). Merge that as a fallback source so
  // the drawer can show every prompt the home is currently capable of
  // displaying for this agent.
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
  // the buttons themselves; no extra hint needed.
  const pinnedNames = new Set(curated ?? merged.map((p) => p.name));

  return (
    <div className="flex flex-col gap-0.5">
      {merged.map((prompt) => (
        <PromptRow
          key={prompt.name}
          agent={agent}
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
  prompt,
  allPromptNames,
  isPinned,
}: {
  agent: VirtualMCPEntity;
  prompt: AgentPrompt;
  /** Every prompt the agent exposes — used when transitioning from
   *  "all (uncurated)" to "curated" so we don't drop everything. */
  allPromptNames: string[];
  isPinned: boolean;
}) {
  const { save } = usePinToHome(agent);
  const [submitting, setSubmitting] = useState(false);

  const handleClick = async () => {
    setSubmitting(true);
    try {
      // Compute next `homePrompts`. Three states:
      //  - uncurated (null) + user clicks Remove → keep every prompt
      //    except this one (transition to curated)
      //  - curated array + user clicks Add → append name
      //  - curated array + user clicks Remove → filter out name
      const current = agent.metadata?.ui?.homePrompts;
      let nextHomePrompts: string[];
      if (!Array.isArray(current)) {
        // Was "all". Removing one means we now need to pin all others.
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
      await save(nextMetadata);
    } catch (err) {
      console.error("[home-tiles] failed to toggle prompt", err);
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
