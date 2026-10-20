/**
 * What the agents are doing right now, off the `in_progress` threads already in
 * the board payload. Hides itself when nothing is running.
 *
 * No progress bar: a run reports no percentage, and one filled from elapsed
 * time is a guess rendered as a measurement.
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

/** `6m`, `2h` — elapsed, not a clock time. Read at render; it does not
 *  tick. */
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
