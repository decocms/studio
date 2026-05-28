/**
 * NextActionsRow
 *
 * Renders below `Chat.Input` on the /$org home page as a row of prompt
 * cards — each opens a new thread with an agent and autosends a prompt.
 *
 * Server filters items so the row stays pared down as the user progresses.
 */

import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
import { useProjectContext } from "@decocms/mesh-sdk";
import { AgentAvatar } from "@/web/components/agent-icon";
import {
  type HomePromptEntry,
  useHomeNextActions,
} from "@/web/hooks/use-home-next-actions";
import { useStartThreadFromPrompt } from "@/web/hooks/use-start-thread-from-prompt";

function PromptCard({
  entry,
  onClick,
}: {
  entry: HomePromptEntry;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group/row flex w-72 grow basis-72 items-center gap-3 rounded-xl border border-border bg-background px-3 py-2.5 text-left outline-none transition-colors hover:border-border hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <AgentAvatar icon={entry.agentIcon} name={entry.agentName} size="sm+" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="w-full truncate text-xs text-muted-foreground">
          {entry.agentName}
        </div>
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
  const { start, startBlank, dialog } = useStartThreadFromPrompt({ agentId });

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

export function NextActionsRow() {
  const { org } = useProjectContext();
  const { isLoading, prompts } = useHomeNextActions(org.slug);

  const isEmpty = !isLoading && prompts.length === 0;
  if (isEmpty) return null;

  return (
    <div className="w-full max-w-5xl mt-4">
      <div className="flex flex-wrap gap-3">
        {isLoading ? (
          Array.from({ length: 3 }, (_, i) => (
            <div
              key={`skeleton-${i}`}
              className="flex w-72 grow basis-72 flex-col gap-1.5 rounded-xl border border-border bg-background px-3 py-2.5"
            >
              <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
              <div className="h-2.5 w-full animate-pulse rounded bg-muted/70" />
            </div>
          ))
        ) : (
          <PromptCardRow entries={prompts} />
        )}
      </div>
    </div>
  );
}
