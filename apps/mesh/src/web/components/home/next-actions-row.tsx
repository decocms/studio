/**
 * NextActionsRow
 *
 * Renders below `Chat.Input` on the /$org home page as a row of prompt
 * cards — each opens a new thread with an agent and autosends a prompt.
 *
 * Server filters items so the row stays pared down as the user progresses.
 */

import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
import { useMCPClient, useProjectContext } from "@decocms/mesh-sdk";
import { cn } from "@deco/ui/lib/utils.ts";
import { MCPAppRenderer } from "@/mcp-apps/mcp-app-renderer.tsx";
import { AgentAvatar } from "@/web/components/agent-icon";
import {
  type HomePromptEntry,
  type HomeTileEntry,
  useHomeNextActions,
} from "@/web/hooks/use-home-next-actions";
import { useStartThreadFromPrompt } from "@/web/hooks/use-start-thread-from-prompt";

function PromptCard({
  entry,
  onClick,
  hideAgent = false,
  disabled = false,
}: {
  entry: HomePromptEntry;
  onClick: () => void;
  /**
   * Inside a tile/group the agent header is already shown above the cards,
   * so don't repeat the avatar + agent name on every card.
   */
  hideAgent?: boolean;
  /** Set while a thread creation is in flight to block duplicate clicks. */
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-busy={disabled}
      className="group/row flex w-72 shrink-0 items-center gap-3 rounded-xl border border-border bg-background px-3 py-2.5 text-left outline-none transition-colors hover:border-border hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-progress disabled:opacity-60"
    >
      {!hideAgent && (
        <AgentAvatar icon={entry.agentIcon} name={entry.agentName} size="sm+" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {!hideAgent && (
          <div className="w-full truncate text-xs text-muted-foreground">
            {entry.agentName}
          </div>
        )}
        <div className="line-clamp-2 w-full text-sm font-medium text-foreground">
          {entry.title}
        </div>
      </div>
    </button>
  );
}

function AgentPromptCardGroup({
  agentId,
  entries,
}: {
  agentId: string;
  entries: HomePromptEntry[];
}) {
  const { start, startBlank, dialog, starting } = useStartThreadFromPrompt({
    agentId,
  });

  const handleClick = (entry: HomePromptEntry) => {
    if (!entry.promptName) {
      void startBlank();
      return;
    }
    const prompt: Prompt = {
      name: entry.promptName,
      title: entry.title,
      description: entry.description,
      arguments: entry.arguments,
      _meta: entry._meta,
    };
    void start(prompt);
  };

  return (
    <>
      {entries.map((entry) => (
        <PromptCard
          key={entry.promptName || `${entry.agentId}:blank`}
          entry={entry}
          onClick={() => handleClick(entry)}
          disabled={starting}
        />
      ))}
      {dialog}
    </>
  );
}

function PromptCardRow({ entries }: { entries: HomePromptEntry[] }) {
  // Each agent's prompts get their own hook scope so the MCP client is
  // correctly keyed by virtual_mcp_id.
  const byAgent = new Map<string, HomePromptEntry[]>();
  for (const e of entries) {
    const existing = byAgent.get(e.agentId);
    if (existing) existing.push(e);
    else byAgent.set(e.agentId, [e]);
  }
  return (
    <>
      {Array.from(byAgent.entries()).map(([agentId, list]) => (
        <AgentPromptCardGroup key={agentId} agentId={agentId} entries={list} />
      ))}
    </>
  );
}

function AgentUITile({
  tile,
  prompts,
}: {
  tile: HomeTileEntry;
  prompts: HomePromptEntry[];
}) {
  const { org } = useProjectContext();
  // The iframe's tool calls go to the *underlying* connection, not the
  // virtual MCP gateway — the gateway namespaces all tool names and would
  // reject bare-name calls coming from the embedded UI.
  const client = useMCPClient({
    connectionId: tile.connectionId,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const { start, startBlank, dialog, starting } = useStartThreadFromPrompt({
    agentId: tile.agentId,
  });

  const handlePromptClick = (entry: HomePromptEntry) => {
    if (!entry.promptName) {
      void startBlank();
      return;
    }
    void start({
      name: entry.promptName,
      title: entry.title,
      description: entry.description,
      arguments: entry.arguments,
      _meta: entry._meta,
    } satisfies Prompt);
  };

  // The blank fallback card is already covered by clicking the tile header,
  // so omit it from the in-tile chips to avoid duplicating "Open chat".
  const promptChips = prompts.filter((p) => !!p.promptName);

  return (
    <div className="flex w-full grow basis-80 flex-col gap-3 rounded-xl border border-border bg-background p-3">
      <button
        type="button"
        onClick={() => void startBlank()}
        disabled={starting}
        aria-busy={starting}
        className="flex items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-progress disabled:opacity-60"
      >
        <AgentAvatar icon={tile.agentIcon} name={tile.agentName} size="sm+" />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="truncate text-sm font-medium text-foreground">
            {tile.agentName}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            Open chat
          </div>
        </div>
      </button>
      <div className="flex min-h-[420px] flex-col gap-3 lg:flex-row lg:items-stretch">
        <div className="flex-1 overflow-hidden rounded-lg border border-border">
          <MCPAppRenderer
            resourceURI={tile.resourceUri}
            orgId={org.id}
            client={client}
            displayMode="fullscreen"
            minHeight={tile.minHeight ?? 420}
            maxHeight={tile.maxHeight ?? 800}
            className="h-full"
          />
        </div>
        {promptChips.length > 0 && (
          <div className="flex flex-wrap gap-3 lg:w-72 lg:shrink-0 lg:flex-col lg:flex-nowrap">
            {promptChips.map((entry) => (
              <PromptCard
                key={entry.promptName}
                entry={entry}
                onClick={() => handlePromptClick(entry)}
                hideAgent
                disabled={starting}
              />
            ))}
          </div>
        )}
      </div>
      {dialog}
    </div>
  );
}

export function NextActionsRow() {
  const { org } = useProjectContext();
  const { isLoading, prompts, tiles } = useHomeNextActions(org.slug);

  const isEmpty = !isLoading && prompts.length === 0 && tiles.length === 0;
  if (isEmpty) return null;

  // Group prompts by agent. Agents that have a tile UI get their prompts
  // rendered inside the tile (as chips); everyone else falls through to the
  // standalone prompt-card row below.
  const tileAgentIds = new Set(tiles.map((t) => t.agentId));
  const promptsByAgent = new Map<string, HomePromptEntry[]>();
  for (const p of prompts) {
    const existing = promptsByAgent.get(p.agentId);
    if (existing) existing.push(p);
    else promptsByAgent.set(p.agentId, [p]);
  }
  const loosePrompts = prompts.filter((p) => !tileAgentIds.has(p.agentId));

  // When the home has at least one UI tile, switch to a 2-column layout on
  // wide screens: tile(s) on the left, loose prompts stacked on the right.
  // Without a tile, prompts fall back to the original wrapping row.
  const hasTile = tiles.length > 0;
  const showRightColumn = isLoading || loosePrompts.length > 0;

  return (
    <div
      className={cn(
        "mt-4 flex w-full max-w-7xl gap-3",
        hasTile ? "flex-col lg:flex-row lg:items-start" : "flex-col",
      )}
    >
      {hasTile && (
        <div className="flex min-w-0 flex-col gap-3 lg:flex-1">
          {tiles.map((tile) => (
            <AgentUITile
              key={tile.agentId}
              tile={tile}
              prompts={promptsByAgent.get(tile.agentId) ?? []}
            />
          ))}
        </div>
      )}
      {showRightColumn && (
        <div
          className={cn(
            "flex gap-3",
            hasTile ? "flex-col lg:w-72 lg:shrink-0" : "flex-wrap",
          )}
        >
          {isLoading ? (
            Array.from({ length: 3 }, (_, i) => (
              <div
                key={`skeleton-${i}`}
                className="flex w-72 shrink-0 flex-col gap-1.5 rounded-xl border border-border bg-background px-3 py-2.5"
              >
                <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
                <div className="h-2.5 w-full animate-pulse rounded bg-muted/70" />
              </div>
            ))
          ) : (
            <PromptCardRow entries={loosePrompts} />
          )}
        </div>
      )}
    </div>
  );
}
