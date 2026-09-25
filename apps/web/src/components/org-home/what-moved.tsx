/**
 * What moved, one line per project.
 *
 * The project's name in the gutter and a sentence beside it, because the
 * question this answers is "did anything happen in MY stores overnight" — and
 * that is read down a column of names, not out of a stack of cards where the
 * same project appears four times.
 *
 * The sentence is the paragraph a workflow wrote for that project
 * (`readWrittenBrief`) when one exists. Nothing writes it yet, so until then
 * each row states the one thing that provably moved: the newest card that
 * broke, or the newest that shipped. Both readings are true; only the first is
 * analysis, and this section is the place it will land.
 *
 * A project with nothing to report has no row. "Nothing happened in farmrio"
 * is not a line worth a reader's eye, and four of them make a quiet night look
 * like an outage.
 */

import { Link } from "@tanstack/react-router";
import { cn } from "@decocms/ui/lib/utils.ts";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { timeAgo } from "@/lib/format-time";
import { useT } from "@/i18n/use-t.ts";
import type { TaskBoardItem } from "@/layouts/task-board/config";
import { type ProjectIndex, tasksForProject } from "@/lib/project-index";
import { readWrittenBrief } from "@/lib/project-brief";
import { AgentAvatar } from "@/components/agent-icon";
import { useNavigateToAgent } from "@/hooks/use-navigate-to-agent";
import {
  DESTINATION_ROUTE,
  PROJECT_ROUTE,
} from "@/hooks/use-destination-route";
import { taskRouteSegment } from "@/layouts/task-board/task-route";
import { track } from "@/lib/posthog-client";
import { HomeCard, HomeCardRow } from "./section";

/** Lanes that mean the work left the board on its own feet. */
const SHIPPED = new Set(["done", "merged"]);

/** The derived reading, kept STRUCTURED rather than pre-composed into a
 *  sentence. A title is a title and a status is a machine fact, and the rest
 *  of the product sets those two differently — fusing them into one quoted
 *  string made this the only row on the home where the thing that happened
 *  was not readable at a glance. */
export interface DerivedMove {
  title: string;
  kind: "failed" | "shipped";
  ago: string;
  /** Further deliveries behind the newest one. */
  more: number;
  /** The card this reading is about, so the row can link straight to it. */
  id: string;
  keySeq: number | null;
}

interface Moved {
  project: VirtualMCPEntity;
  /** The workflow's paragraph, when one has been written. Genuine prose, so
   *  it stays prose. */
  written: string | null;
  derived: DerivedMove | null;
}

/**
 * The one thing that provably moved in a project, newest first.
 *
 * A break outranks a delivery: something that shipped is good news you can read
 * later, something that failed is the reason you opened the page.
 */
export function derivedMove(
  tasks: readonly TaskBoardItem[],
): DerivedMove | null {
  const byNewest = [...tasks].sort((a, b) =>
    (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
  );
  const broke = byNewest.find((task) =>
    task.threads.some((thread) => thread.status === "failed"),
  );
  if (broke) {
    return {
      title: broke.title,
      kind: "failed",
      ago: timeAgo(broke.updatedAt),
      more: 0,
      id: broke.id,
      keySeq: broke.keySeq,
    };
  }
  const shipped = byNewest.filter((task) => SHIPPED.has(task.status));
  const latest = shipped[0];
  if (!latest) return null;
  return {
    title: latest.title,
    kind: "shipped",
    ago: timeAgo(latest.updatedAt),
    more: shipped.length - 1,
    id: latest.id,
    keySeq: latest.keySeq,
  };
}

export function WhatMoved({
  projects,
  index,
  tasks,
  orgSlug,
}: {
  projects: readonly VirtualMCPEntity[];
  index: ProjectIndex;
  tasks: readonly TaskBoardItem[];
  orgSlug: string;
}) {
  const t = useT();
  const navigateToAgent = useNavigateToAgent();

  const moved: Moved[] = [];
  for (const project of projects) {
    const mine = tasksForProject(tasks, index, project.id);
    const written = readWrittenBrief(project);
    const derived = derivedMove(mine);
    if (!written && !derived) continue;
    moved.push({ project, written: written?.text ?? null, derived });
  }
  if (moved.length === 0) return null;

  return (
    <HomeCard
      label={t("home.whatMoved.heading")}
      action={
        <Link
          to={DESTINATION_ROUTE.tasks}
          params={{ org: orgSlug, taskKey: undefined }}
          className="text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          {t("home.whatMoved.seeBoard")}
        </Link>
      }
    >
      {moved.map(({ project, written, derived }) => (
        <HomeCardRow key={project.id}>
          <div className="flex items-start gap-3">
            {/* The project's own mark, not its name: the icon is how a project
                is recognised everywhere else in the product, and a fixed box
                starts every sentence at one x however long the names are. */}
            <button
              type="button"
              onClick={() => {
                track("home_what_moved_clicked");
                navigateToAgent(project.id);
              }}
              className="mt-0.5 shrink-0 rounded-md transition-opacity hover:opacity-80"
              aria-label={project.title}
              title={project.title}
            >
              <AgentAvatar icon={project.icon} name={project.title} size="xs" />
            </button>
            {/* A workflow's paragraph is prose and stays prose. The derived
                reading gets the same anatomy as every other row on this page:
                the thing that happened, then the machine facts under it. Both
                link out — a written brief has no one card to name, so it
                opens the project's board; a derived reading names one, so it
                opens that card directly. */}
            {written ? (
              <Link
                to={PROJECT_ROUTE.tasks}
                params={{
                  org: orgSlug,
                  agentId: project.id,
                  taskKey: undefined,
                }}
                onClick={() => track("home_what_moved_clicked")}
                className="min-w-0 flex-1 text-sm leading-6 text-foreground hover:underline"
              >
                {written}
              </Link>
            ) : (
              derived && (
                <Link
                  to={PROJECT_ROUTE.tasks}
                  params={{
                    org: orgSlug,
                    agentId: project.id,
                    taskKey: taskRouteSegment(orgSlug, derived),
                  }}
                  onClick={() => track("home_what_moved_clicked")}
                  className="flex min-w-0 flex-1 flex-col gap-1"
                >
                  <span className="text-sm leading-5 text-foreground hover:underline">
                    {derived.title}
                  </span>
                  <span className="text-meta flex flex-wrap items-center gap-1.5">
                    <span
                      className={cn(
                        derived.kind === "failed"
                          ? "text-destructive"
                          : "text-success",
                      )}
                    >
                      {t(
                        derived.kind === "failed"
                          ? "home.whatMoved.statusFailed"
                          : "home.whatMoved.statusShipped",
                      )}
                    </span>
                    <span aria-hidden>·</span>
                    <span>{project.title}</span>
                    <span aria-hidden>·</span>
                    <span>{derived.ago}</span>
                    {derived.more > 0 && (
                      <>
                        <span aria-hidden>·</span>
                        <span>
                          {t("home.whatMoved.andMore", {
                            count: derived.more,
                          })}
                        </span>
                      </>
                    )}
                  </span>
                </Link>
              )
            )}
          </div>
        </HomeCardRow>
      ))}
    </HomeCard>
  );
}
