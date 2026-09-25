/**
 * The projects, and the number each one is moving.
 *
 * The home's navigation, in the shape that makes it worth reading before you
 * click: a name, a rhythm, and one headline ranked by how much it wants you
 * (see `projectSummaries`). A row that answers "is there anything for me in
 * here" saves the trip into a project that turns out to be quiet.
 *
 * The number is delivery, not a business goal. A project does not declare a
 * goal anywhere in this product, and inventing a field to hold one is the
 * mistake `lib/project-profile.ts` exists to prevent — so the column says what
 * it can prove: what shipped over `RHYTHM_DAYS`, and its second half against
 * its first.
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

/**
 * Colour is spent once on this page, and the queue above already spent it.
 *
 * "Waiting on you" leads the ranking because a row that says "3 shipped" while
 * a run is stopped on an answer is a row that cost someone their morning — but
 * it is stated, not alarmed: the Needs-you card names every one of those cards
 * in warning already. Only a break gets colour here, because that is the one
 * thing the queue above does NOT carry.
 */
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

/** One half of the rhythm window against the other, or nothing — which is the
 *  right answer more often than it looks. */
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
            <span className="text-sm tabular-nums text-foreground">
              {shipped}
            </span>
            <Delta value={current} previous={previous} />
          </span>
        </span>
      </button>
    </HomeCardRow>
  );
}

/** Empty by default: the classic org home has no daily-pulse query to draw
 *  summaries or series from, and every row degrades to its quiet state. */
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
  /** The block's own control — "New project". Passed in rather than imported
   *  so the roster owns no creation path. */
  action?: ReactNode;
}) {
  const t = useT();
  const { org } = useProjectContext();
  /** Most recent first, then capped — the home leads with what you touched last
   *  and hands the tail to "See all". */
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
