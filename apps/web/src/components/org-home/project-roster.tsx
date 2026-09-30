/**
 * The projects, each with a rhythm and one ranked headline
 * (`projectSummaries`), so a row answers "is there anything for me in here"
 * before you click it.
 *
 * The number is delivery, not a business goal — see `lib/project-profile.ts`.
 */

import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowDown, ArrowUp } from "@untitledui/icons";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { AgentAvatar } from "@/components/agent-icon";
import { useNavigateToAgent } from "@/hooks/use-navigate-to-agent";
import { readProjectProfile, storeHost } from "@/lib/project-profile.ts";
import { useProjectContext } from "@/sdk";
import { track } from "@/lib/posthog-client";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";
import type { ProjectHeadlineKind, ProjectSummary } from "./daily-pulse";
import { HomeCard, HomeCardRow } from "./section";
import { Sparkline } from "./sparkline";

/** "Waiting on you" leads the ranking, but only a break spends colour — the
 *  queue above already names everything else in warning. */
const HEADLINE: Record<
  Exclude<ProjectHeadlineKind, "quiet">,
  { labelKey: TranslationKey; className: string }
> = {
  waiting: {
    labelKey: "home.projects.headlineWaiting",
    className: "text-foreground",
  },
  failed: {
    labelKey: "home.projects.headlineFailed",
    className: "text-destructive",
  },
  shipped: {
    labelKey: "home.projects.headlineShipped",
    className: "text-muted-foreground",
  },
  open: {
    labelKey: "home.projects.headlineOpen",
    className: "text-muted-foreground",
  },
};

/** Projects the home shows before it defers to Settings › Projects. */
const MAX_PROJECTS = 6;

/** One half of the rhythm window against the other, or nothing. */
function Delta({ value, previous }: { value: number; previous: number }) {
  const diff = value - previous;
  if (diff === 0) return null;
  const Glyph = diff > 0 ? ArrowUp : ArrowDown;
  return (
    <span
      className={cn(
        "inline-flex items-center text-xs tabular-nums",
        diff > 0 ? "text-success" : "text-muted-foreground",
      )}
    >
      <Glyph width={11} height={11} aria-hidden />
      {Math.abs(diff)}
    </span>
  );
}

function ProjectRosterItem({
  project,
  summary,
  series,
}: {
  project: VirtualMCPEntity;
  summary: ProjectSummary | undefined;
  /** Cards shipped per day, oldest first — the row's rhythm. */
  series: readonly number[];
}) {
  const t = useT();
  const navigateToAgent = useNavigateToAgent();
  const host = storeHost(readProjectProfile(project).storeUrl);
  const headline =
    summary && summary.kind !== "quiet" ? HEADLINE[summary.kind] : null;
  const shipped = series.reduce((sum, day) => sum + day, 0);
  const half = Math.floor(series.length / 2);
  const previous = series.slice(0, half).reduce((sum, day) => sum + day, 0);
  const current = series.slice(half).reduce((sum, day) => sum + day, 0);

  return (
    <HomeCardRow className="transition-colors hover:bg-accent/40">
      <button
        type="button"
        /** The row's name is the project, not everything printed in it: the
         *  rhythm, the count and the delta are context beside the title, and
         *  reading them as part of the control's name says nothing useful. */
        aria-label={project.title}
        onClick={() => {
          track("org_home_project_clicked");
          navigateToAgent(project.id);
        }}
        className="flex w-full min-w-0 items-center gap-3 text-left"
      >
        <AgentAvatar icon={project.icon} name={project.title} size="xs" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-foreground">
            {project.title}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {headline && summary
              ? t(headline.labelKey, { count: summary.count })
              : (host ?? t("home.projects.quiet"))}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2.5">
          <Sparkline
            series={series}
            className="text-muted-foreground/60"
            label={t("home.projects.rhythm", { name: project.title })}
          />
          <span className="flex w-10 shrink-0 flex-col items-end">
            {/* A quiet zero, so the projects that did ship stand out. */}
            <span
              className={cn(
                "text-sm tabular-nums",
                shipped > 0 ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {shipped}
            </span>
            <Delta value={current} previous={previous} />
          </span>
        </span>
      </button>
    </HomeCardRow>
  );
}

/** Empty by default, so a caller with no daily-pulse query still renders every
 *  row in its quiet state. */
const NO_SUMMARIES: Map<string, ProjectSummary> = new Map();
const NO_SERIES: Map<string, readonly number[]> = new Map();

export function ProjectRoster({
  projects,
  summaries = NO_SUMMARIES,
  series = NO_SERIES,
  action,
}: {
  projects: VirtualMCPEntity[];
  /** One headline per project id, from `projectSummaries`. */
  summaries?: Map<string, ProjectSummary>;
  /** Shipped-per-day per project id, from `shippedSeries`. */
  series?: Map<string, readonly number[]>;
  /** Passed in rather than imported, so the roster owns no creation path. */
  action?: ReactNode;
}) {
  const t = useT();
  const { org } = useProjectContext();
  /** Most recent first, then capped; the tail goes to "See all". */
  const recent = [...projects]
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
    .slice(0, MAX_PROJECTS);
  const hasMore = projects.length > MAX_PROJECTS;

  return (
    <HomeCard
      label={t("home.projects.heading")}
      count={projects.length}
      action={
        <span className="flex items-center gap-3">
          {/* The aside is a narrow column, so this labels the number column
              only where it actually fits beside the block's own title. */}
          <span className="hidden whitespace-nowrap text-xs text-muted-foreground @[19rem]:inline">
            {t("home.projects.shippedCaption")}
          </span>
          {action}
        </span>
      }
    >
      {recent.map((project) => (
        <ProjectRosterItem
          key={project.id}
          project={project}
          summary={summaries.get(project.id)}
          series={series.get(project.id) ?? []}
        />
      ))}
      {hasMore && (
        <HomeCardRow className="py-2">
          <Link
            to="/$org/settings/projects"
            params={{ org: org.slug }}
            className="text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            {t("home.projects.seeAll")}
          </Link>
        </HomeCardRow>
      )}
    </HomeCard>
  );
}
