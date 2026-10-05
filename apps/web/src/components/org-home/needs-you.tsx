/**
 * What is stopped waiting on a person, across every project — the first and
 * densest block. A `user_ask` run and an unowned review both miss an assignee
 * filter, which is why they get missed.
 *
 * Every row states what it can prove about itself, off the board payload the
 * page already loads. With nothing to show it says so in a line rather than
 * disappearing.
 */

import { Link } from "@tanstack/react-router";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle,
  Clock,
  HelpCircle,
} from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { ProjectIcon } from "@/components/project-icon";
import {
  DESTINATION_ROUTE,
  PROJECT_ROUTE,
} from "@/hooks/use-destination-route";
import { useT } from "@/i18n/use-t.ts";
import type { TFunction, TranslationKey } from "@/i18n/use-t.ts";
import { taskRouteSegment } from "@/layouts/task-board/task-route";
import type { TaskBoardItem } from "@/layouts/task-board/config";
import { projectForTask, type ProjectIndex } from "@/lib/project-index";
import { track } from "@/lib/posthog-client";
import { attentionReason, type AttentionReason } from "./daily-pulse";
import { HomeCard, HomeCardRow } from "./section";

/** Rows shown before the block defers to the board. */
const MAX_ROWS = 5;

/** The kind of ask, and the verb on its button. A question is the only one
 *  actually blocking, so it is the only one that spends colour. */
const REASON: Record<
  AttentionReason,
  {
    labelKey: TranslationKey;
    actionKey: TranslationKey;
    blocking: boolean;
    Icon: typeof CheckCircle;
  }
> = {
  answer: {
    labelKey: "home.needsYou.reasonAnswer",
    actionKey: "home.needsYou.actionAnswer",
    blocking: true,
    Icon: HelpCircle,
  },
  review: {
    labelKey: "home.needsYou.reasonReview",
    actionKey: "home.needsYou.actionReview",
    blocking: false,
    Icon: AlertCircle,
  },
  assigned: {
    labelKey: "home.needsYou.reasonAssigned",
    actionKey: "home.needsYou.actionOpen",
    blocking: false,
    Icon: Clock,
  },
};

/** What the row can prove about itself, in the order it earns trust. */
function evidenceOf(task: TaskBoardItem, t: TFunction): string[] {
  const facts: string[] = [];
  if (task.reviewVerdicts.some((v) => v.verdict === "approved" && v.verified)) {
    facts.push(t("home.needsYou.evidenceReviewed"));
  }
  if (task.previewRoutes.length > 0 || task.threads.some((r) => r.hasPreview)) {
    facts.push(t("home.needsYou.evidencePreview"));
  }
  const cost = task.threads.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  if (cost > 0) {
    facts.push(cost < 10 ? `$${cost.toFixed(2)}` : `$${Math.round(cost)}`);
  }
  return facts;
}

function NeedsYouRow({
  task,
  index,
  orgSlug,
  projectId,
}: {
  task: TaskBoardItem;
  index: ProjectIndex;
  orgSlug: string;
  projectId?: string;
}) {
  const t = useT();
  const project = projectForTask(task, index);
  const reason = REASON[attentionReason(task)];
  const meta = [project?.title, ...evidenceOf(task, t)].filter(Boolean);
  const to = projectId ? PROJECT_ROUTE.tasks : DESTINATION_ROUTE.tasks;
  const params = {
    org: orgSlug,
    agentId: projectId,
    taskKey: taskRouteSegment(orgSlug, task),
  };

  return (
    <HomeCardRow className="p-0">
      {/* The whole row is the link — `reason.actionKey`'s pill is a visual
          affordance, not a second target, so it renders as a `span` rather
          than nesting an anchor/button inside this one. */}
      <Link
        to={to}
        params={params}
        onClick={() => track("home_needs_you_clicked")}
        className="flex items-start gap-3 px-5 py-3.5"
      >
        <span
          className={cn(
            "mt-0.5 flex size-5 shrink-0 items-center justify-center",
            reason.blocking ? "text-warning" : "text-muted-foreground",
          )}
        >
          <reason.Icon size={16} aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="text-sm font-medium text-foreground">
            {task.title}
          </span>
          {/* Which project, whether it is reviewed, what it cost — none of it
              written by a person, so all of it in the machine voice. A div
              rather than a p because it carries `ProjectIcon`, and a div
              inside a p is invalid HTML React reports as a hydration error. */}
          <div className="text-meta flex min-w-0 flex-wrap items-center gap-1.5">
            {project && (
              <span className="flex size-3.5 shrink-0 items-center justify-center">
                <ProjectIcon icon={project.icon} name={project.title} />
              </span>
            )}
            <span className="min-w-0 truncate">{meta.join(" · ")}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={cn(
              "hidden text-xs @lg:inline",
              reason.blocking ? "text-warning" : "text-muted-foreground",
            )}
          >
            {t(reason.labelKey)}
          </span>
          <Button
            asChild
            variant="secondary"
            size="sm"
            className="pointer-events-none"
          >
            <span>
              {t(reason.actionKey)}
              <ArrowRight size={13} aria-hidden />
            </span>
          </Button>
        </div>
      </Link>
    </HomeCardRow>
  );
}

export function NeedsYou({
  tasks,
  index,
  orgSlug,
  projectId,
}: {
  /** Already filtered and ordered by `tasksNeedingMe` — oldest first. */
  tasks: TaskBoardItem[];
  index: ProjectIndex;
  orgSlug: string;
  /** Stay inside a project: the rows open that project's board. */
  projectId?: string;
}) {
  const t = useT();
  const shown = tasks.slice(0, MAX_ROWS);
  const rest = tasks.length - shown.length;

  return (
    <div data-testid="home-needs-you">
      <HomeCard label={t("home.needsYou.heading")}>
        {tasks.length === 0 ? (
          <HomeCardRow>
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <CheckCircle
                size={15}
                className="shrink-0 text-success"
                aria-hidden
              />
              {t("home.needsYou.allClear")}
            </p>
          </HomeCardRow>
        ) : (
          <>
            {shown.map((task) => (
              <NeedsYouRow
                key={task.id}
                task={task}
                index={index}
                orgSlug={orgSlug}
                projectId={projectId}
              />
            ))}
            {rest > 0 && (
              <HomeCardRow className="py-2">
                <Link
                  to={projectId ? PROJECT_ROUTE.tasks : DESTINATION_ROUTE.tasks}
                  params={{
                    org: orgSlug,
                    agentId: projectId,
                    taskKey: undefined,
                  }}
                  className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                >
                  {t("home.needsYou.seeAll", { count: rest })}
                </Link>
              </HomeCardRow>
            )}
          </>
        )}
      </HomeCard>
    </div>
  );
}
