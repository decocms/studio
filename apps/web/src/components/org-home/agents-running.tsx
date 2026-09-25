/**
 * What the agents are doing right now.
 *
 * The one block that says the product is working while you look at it — every
 * other part of a daily brief reports finished work, which reads as a log. It
 * costs nothing: `in_progress` threads are already in the board payload the
 * page loads, so this is a read of data in hand.
 *
 * It hides itself when nothing is running, because "0 agents running" is a
 * sentence that makes a quiet morning look broken.
 *
 * There is deliberately no progress bar. A run reports no percentage — nothing
 * in the payload knows how far along it is — and a bar drawn from elapsed time
 * would be a guess rendered as a measurement.
 */

import { Link } from "@tanstack/react-router";
import { Stars01 } from "@untitledui/icons";
import {
  DESTINATION_ROUTE,
  PROJECT_ROUTE,
} from "@/hooks/use-destination-route";
import { useT } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";
import type { RunningAgent } from "./daily-pulse";
import { HomeCard, HomeCardRow } from "./section";

/** Rows shown before the block defers to the board. */
const MAX_ROWS = 5;

/** `6m`, `2h` — elapsed, not a clock time. How long a run has been going is the
 *  thing that tells you whether to look at it; when it started is not. Read at
 *  render like every other relative time in the app: it does not tick, and a
 *  run nobody is watching does not need it to. */
function elapsed(startedAt: string): string {
  const at = Date.parse(startedAt);
  if (Number.isNaN(at)) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export function AgentsRunning({
  agents,
  orgSlug,
  projectId,
}: {
  agents: readonly RunningAgent[];
  orgSlug: string;
  /** Stay inside a project: the rows open that project's board. */
  projectId?: string;
}) {
  const t = useT();
  if (agents.length === 0) return null;
  const shown = agents.slice(0, MAX_ROWS);

  return (
    <HomeCard label={t("home.running.heading")} count={agents.length}>
      {shown.map((agent) => (
        <HomeCardRow
          key={agent.threadId}
          className="transition-colors hover:bg-accent/40"
        >
          <Link
            to={projectId ? PROJECT_ROUTE.tasks : DESTINATION_ROUTE.tasks}
            params={{ org: orgSlug, agentId: projectId, taskKey: undefined }}
            onClick={() => track("home_running_clicked")}
            className="flex min-w-0 items-center gap-2.5"
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Stars01 size={13} aria-hidden />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-foreground text-sm">
                {agent.runTitle ?? agent.taskTitle}
              </span>
              {/* Only when the run named itself something OTHER than its card.
                  A run that inherited the card's title would otherwise print it
                  twice, which reads as a rendering bug rather than as context. */}
              {agent.runTitle && agent.runTitle !== agent.taskTitle && (
                <span className="truncate text-muted-foreground text-xs">
                  {agent.taskTitle}
                </span>
              )}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {elapsed(agent.startedAt)}
            </span>
          </Link>
        </HomeCardRow>
      ))}
    </HomeCard>
  );
}
