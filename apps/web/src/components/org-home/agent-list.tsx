/** The org home's agent roster, as an item list rather than a card grid.
 *
 *  Deliberately NOT `ProjectCard`. The home is a place you pass through on the
 *  way somewhere, so a row carries only what picks one agent out of a list —
 *  its icon, its name, and the repo behind it — and the whole row is the click
 *  target. Managing an agent (rename, pin, delete) stays on Settings › Agents,
 *  which keeps the cards; the two surfaces are different jobs and now look it.
 */

import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { cn } from "@decocms/ui/lib/utils.ts";
import { AgentAvatar } from "@/components/agent-icon";
import { GitHubIcon } from "@/components/icons/github-icon";
import { landingTabIdFor } from "@/layouts/main-panel-tabs/tab-id";
import { useNavigateToAgent } from "@/hooks/use-navigate-to-agent";
import { projectRepo } from "@/hooks/use-project-scope";
import { agentHasClonableSource } from "@/lib/agent-capabilities";

function AgentListRow({
  agent,
  isLast,
}: {
  agent: VirtualMCPEntity;
  isLast: boolean;
}) {
  const navigateToAgent = useNavigateToAgent();
  const repo = projectRepo(agent);
  const isCodeAgent = agentHasClonableSource(agent.metadata);

  return (
    <button
      type="button"
      onClick={() =>
        navigateToAgent(agent.id, {
          panel: landingTabIdFor(agent.metadata?.ui?.layout),
        })
      }
      className={cn(
        "group flex h-14 w-full items-center gap-3 px-2 text-left transition-colors hover:bg-accent/50",
        "focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        !isLast && "border-b border-border",
      )}
    >
      {/* aria-hidden because the row's accessible name is the agent's name:
          `AgentAvatar` renders an <img alt={name}> that would repeat it. */}
      <span className="relative shrink-0" aria-hidden="true">
        <AgentAvatar icon={agent.icon} name={agent.title} size="sm" />
        {isCodeAgent && (
          <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full border border-background bg-muted text-muted-foreground">
            <GitHubIcon size={10} />
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">
          {agent.title}
        </span>
        {/* Only repo-backed agents get a second line — an empty one would make
            every row taller for the sake of the few that have something. */}
        {repo && (
          <span className="truncate text-xs text-muted-foreground">{repo}</span>
        )}
      </span>
    </button>
  );
}

/** One labelled group of rows ("Code agents", "Agents") with its count. Renders
 *  nothing when the group is empty, so a heading never stands over a void. */
export function AgentListGroup({
  heading,
  agents,
}: {
  /** Omitted for a single ungrouped list, where the section above already
   *  names and counts what follows. */
  heading?: string;
  agents: VirtualMCPEntity[];
}) {
  if (agents.length === 0) return null;

  return (
    <div className="flex flex-col">
      {heading ? (
        <div className="mb-1 flex items-center gap-2 px-2">
          <h3 className="text-sm font-medium text-muted-foreground">
            {heading}
          </h3>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            {agents.length}
          </span>
        </div>
      ) : null}
      <div className="flex flex-col border-t border-border">
        {agents.map((agent, index) => (
          <AgentListRow
            key={agent.id}
            agent={agent}
            isLast={index === agents.length - 1}
          />
        ))}
      </div>
    </div>
  );
}
