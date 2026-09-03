/**
 * The org home's feed — one card per card, newest first, across every project.
 *
 * Shaped like GitHub's: a chronological stack, not a per-project grouping. The
 * grouping it replaced sorted projects by recency and then listed each one's
 * cards, which meant the single most recent thing in the org could sit fourth
 * on the page, under two headers. A stack answers "what happened" in reading
 * order and puts the project on each card, where it is context rather than
 * structure. Narrowing to ONE project is what the filter is for — a choice,
 * instead of a shape imposed on every visit.
 *
 * It reads the board the org home already loads, so it costs no extra request.
 */

import { useState, type ComponentType, type ReactNode } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { FilterLines } from "@untitledui/icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { ProjectIcon } from "@/components/project-icon";
import { GitHubIcon } from "@/components/icons/github-icon";
import { LAYOUT_TOUR_ANCHORS } from "@/components/layout-tour/anchors";
import {
  taskBoardItemsQueryOptions,
  useBoardColumns,
  useTaskBoardLiveSync,
} from "@/hooks/use-task-board-items";
import { useNavigateToAgent } from "@/hooks/use-navigate-to-agent";
import {
  buildProjectIndex,
  entryForTask,
  projectForTask,
  type ProjectIndex,
  type ProjectIndexEntry,
} from "@/lib/project-index";
import { landingTabIdFor } from "@/layouts/main-panel-tabs/tab-id";
import {
  DEFAULT_TASK_TYPE,
  PRIORITY_CONFIG,
  SUPER_AGENT_ASSIGNEE_ID,
  TASK_TYPE_CONFIG,
  laneHeader,
  type Member,
  type TaskBoardItem,
} from "@/layouts/task-board/config";
import { TaskAssigneeAvatar } from "@/components/task-assignee-avatar";
import { useMembersQuery } from "@/hooks/use-members";
import { taskRouteSegment } from "@/layouts/task-board/task-route";
import { formatTimeAgo } from "@/lib/format-time";
import { useStudioTools } from "@/lib/studio-tools";
import { taskKey } from "@decocms/shared/task-key";
import { useProjectContext } from "@/sdk";
import { useT } from "@/i18n/use-t.ts";

/** Cards the stack shows before it defers to the board. */
const MAX_CARDS = 20;

/** Priorities worth a chip — the ones above the default. */
const NOTABLE_PRIORITIES = new Set(["high", "urgent"]);

export interface FeedEntry {
  task: TaskBoardItem;
  /** The bucket the card belongs to — a project, or the repository two
   *  projects share. */
  bucket: ProjectIndexEntry;
  /** The one project to name on the card, or null when the bucket holds
   *  several and nothing says which. */
  project: VirtualMCPEntity | null;
}

/**
 * The stack, in render order: every attributable card newest first, optionally
 * narrowed to one bucket.
 *
 * The feed is the board's list view, not a trophy cabinet — a card belongs here
 * from the moment it exists, in whatever lane it is in. It carried only settled
 * work once, which meant the composer on the project home created cards its own
 * feed could not show, and an org whose team was mid-flight had an empty home
 * until something shipped. `archived` is still excluded: deleted work is not
 * activity.
 *
 * Attribution comes from the shared project index rather than a local
 * `Map<repo, project>` — the two copies of that map (here and in the sidebar)
 * resolved a repository two projects share by iteration order, silently routing
 * one project's cards to its sibling.
 *
 * A card no bucket claims is still left out rather than guessed at. The index
 * is built from the projects this feed was GIVEN — the project home passes one
 * — so "no bucket" is also how the project home stays one project's feed.
 *
 * Pure, and exported for its test — the ordering and the attribution rule ARE
 * the feature, and neither is something a screenshot can verify.
 */
export function buildFeed(
  index: ProjectIndex,
  tasks: TaskBoardItem[],
  bucketId: string | null,
): FeedEntry[] {
  const entries: FeedEntry[] = [];
  for (const task of tasks) {
    /** Deleted work is not activity; every other lane belongs here. */
    if (task.status === "archived") continue;
    const bucket = entryForTask(task, index);
    if (!bucket) continue;
    if (bucketId && bucket.id !== bucketId) continue;
    entries.push({ task, bucket, project: projectForTask(task, index) });
  }

  return entries
    .sort((a, b) =>
      (b.task.updatedAt ?? "").localeCompare(a.task.updatedAt ?? ""),
    )
    .slice(0, MAX_CARDS);
}

/** The filter, in the section header the way GitHub puts it above the stack.
 *  Its options are the index's buckets, so two projects over one monorepo offer
 *  one row rather than two that select the same cards. */
function ProjectFilter({
  index,
  value,
  onChange,
}: {
  index: ProjectIndex;
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const t = useT();
  const selected = value ? index.byId.get(value) : undefined;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5">
          <FilterLines size={14} />
          {selected ? selected.title : t("home.projectFeed.filterAll")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuRadioGroup
          value={value ?? ""}
          onValueChange={(next) => onChange(next || null)}
        >
          <DropdownMenuRadioItem value="">
            {t("home.projectFeed.filterAll")}
          </DropdownMenuRadioItem>
          {index.entries.map((entry) => (
            <DropdownMenuRadioItem key={entry.id} value={entry.id}>
              <span className="truncate">{entry.title}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One fact about a card, as a hairline pill — the shape the composer's
 *  attribute chips use, so a task reads the same being asked for and being
 *  reported. `--border-hairline` is 1px, or a true half pixel on retina. */
function MetaPill({
  icon: Icon,
  iconClassName,
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  iconClassName: string;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-full border-[length:var(--border-hairline)] border-border px-2 text-xs text-muted-foreground">
      <Icon className={cn("size-3.5 shrink-0", iconClassName)} />
      {children}
    </span>
  );
}

function FeedCard({
  entry,
  memberById,
}: {
  entry: FeedEntry;
  memberById: Map<string, Member>;
}) {
  const t = useT();
  const navigate = useNavigate();
  const navigateToAgent = useNavigateToAgent();
  const orgSlug = useParams({ strict: false }).org ?? "";
  /** The lanes only — `useTaskBoardItems` also opens the board's SSE
   *  subscriptions, and a lane LABEL should not cost the org home a stream. */
  const columns = useBoardColumns();

  const { task, bucket, project } = entry;
  const lane = laneHeader(task.status, t, columns);
  const LaneIcon = lane.visual.icon;
  const priority = PRIORITY_CONFIG[task.priority];
  const PriorityIcon = priority.icon;
  const type = TASK_TYPE_CONFIG[task.type ?? DEFAULT_TASK_TYPE];
  const TypeIcon = type.icon;
  const key = taskKey(orgSlug, task.keySeq, task.jiraIssueKey);
  const assignee = task.assigneeId
    ? memberById.get(task.assigneeId)
    : undefined;
  const assigneeTitle =
    task.assigneeId === SUPER_AGENT_ASSIGNEE_ID
      ? t("taskBoard.taskDialog.superAgentLabel")
      : (assignee?.user?.name ?? undefined);

  return (
    <article className="card-shadow flex flex-col gap-4 rounded-xl bg-card p-6">
      {/* The identity line: who this belongs to, which card it is, when it
          moved. The key sits HERE and not beside the title — it is an address,
          not part of the sentence, and inline it split the one line a reader
          actually scans. Both identifiers now share a row, and the title gets
          a line to itself.
          The project is a separate control from the title below rather than a
          wrapper around it: one card, two destinations, and nesting them would
          put a button inside a button. No repo beside the name either — a
          project is usually NAMED for its repo, so the line read
          "decocms-tanstack deco-sites/decocms-tanstack".
          A bucket several projects share names the REPOSITORY and opens
          nothing: neither sibling's workspace is the honest destination for
          work that could belong to either. */}
      <div className="flex items-center gap-2.5">
        {project ? (
          <button
            type="button"
            onClick={() =>
              navigateToAgent(project.id, {
                panel: landingTabIdFor(project.metadata?.ui?.layout),
              })
            }
            className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md text-left text-sm font-medium text-foreground transition-colors hover:text-primary"
          >
            <ProjectIcon icon={project.icon} name={project.title} />
            <span className="truncate">{project.title}</span>
          </button>
        ) : (
          <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-muted-foreground">
            <GitHubIcon className="size-4 shrink-0" />
            <span className="truncate">{bucket.title}</span>
          </span>
        )}
        {key && (
          <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
            {key}
          </span>
        )}
        <span className="ml-auto shrink-0 text-sm text-muted-foreground">
          {formatTimeAgo(new Date(task.updatedAt))}
        </span>
        {/* Who is holding it. A card handed to the agent carries a sentinel id
            that resolves to no member, so this has to be the shared glyph — a
            plain member lookup renders nothing for exactly the assignee that is
            never a person. */}
        <TaskAssigneeAvatar
          assigneeId={task.assigneeId}
          assignee={assignee}
          title={assigneeTitle}
        />
      </div>

      <button
        type="button"
        onClick={() =>
          navigate({
            to: "/$org/tasks/{-$taskKey}",
            params: { org: orgSlug, taskKey: taskRouteSegment(orgSlug, task) },
          })
        }
        className="flex cursor-pointer flex-col items-start gap-2.5 text-left"
      >
        <span className="text-lg leading-snug font-semibold text-foreground transition-colors hover:text-primary">
          {task.title}
        </span>
        {/* Pills, so the middle dots can go: a bordered chip separates itself,
            and the row was three facts held apart by punctuation. */}
        <span className="flex flex-wrap items-center gap-1.5">
          <MetaPill icon={LaneIcon} iconClassName={lane.visual.iconClassName}>
            {lane.label}
          </MetaPill>
          {/* `TASK_TYPE_CONFIG`, not the raw `task.type`: the board already
              owns a glyph and a translated name per kind, and printing the wire
              value put an untranslated lowercase "chore" beside a translated
              "Em Revisão". */}
          <MetaPill icon={TypeIcon} iconClassName={type.iconClassName}>
            {t(type.labelKey)}
          </MetaPill>
          {/* Only when it is ABOVE the default. A chip reading "Medium" on
              every card is a column of noise; "Urgent" on one of them is the
              thing you are scanning for. */}
          {NOTABLE_PRIORITIES.has(task.priority) && (
            <MetaPill
              icon={PriorityIcon}
              iconClassName={priority.iconClassName}
            >
              {t(priority.labelKey)}
            </MetaPill>
          )}
        </span>
      </button>

      {/* Plain, not GitHub's tinted block: at this width the tint was a grey
          slab under every card. `leading-relaxed` is what earns it the space
          instead — prose at 1.4 in a 24px-padded card reads as a caption. */}
      {task.description && (
        <p className="line-clamp-3 text-sm leading-relaxed text-muted-foreground">
          {task.description}
        </p>
      )}
    </article>
  );
}

/**
 * The org's board, read with SUSPENSE.
 *
 * The home has to know whether there is anything to show BEFORE it lays itself
 * out, and a non-suspense read answers "nothing" first and "something" a moment
 * later — a shift on every visit to an org that has a board. This shares the
 * board's query key, so it is the same request, just awaited — and mounts the
 * same live sync, so a card another actor moves reaches the feed the way it
 * reaches the board. Sharing the key alone would not: the SSE upserts and the
 * polling backstop hang off the subscription, not the cache entry.
 */
export function useOrgTasksSuspense(): TaskBoardItem[] {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  useTaskBoardLiveSync();
  const { data } = useSuspenseQuery(
    taskBoardItemsQueryOptions(locator, studio),
  );
  return data.items;
}

export function ProjectFeed({
  projects,
  tasks,
  action,
  showFilter = true,
}: {
  projects: VirtualMCPEntity[];
  tasks: TaskBoardItem[];
  /** The page's own control for this section — today, "Import from GitHub".
   *  Passed in rather than imported so the feed owns no creation path. */
  action?: ReactNode;
  /** Off inside a project: the list is already one project, so a filter whose
   *  only option is the thing you are looking at is a control that cannot do
   *  anything. */
  showFilter?: boolean;
}) {
  const t = useT();
  const [bucketId, setBucketId] = useState<string | null>(null);
  /** From the projects this feed was GIVEN, and nothing else. The project home
   *  passes one project, and that is what keeps its feed to one project's work
   *  — a card whose repository is not in this index simply has no bucket. */
  const index = buildProjectIndex(projects);
  const entries = buildFeed(index, tasks, bucketId);
  /** Non-blocking and resolved ONCE for the stack: an assignee is decoration on
   *  a card that is already legible without it, so the feed must not wait on
   *  the member list to paint. Until it lands, a human assignee simply has no
   *  glyph — the agent's does not need one. */
  const { data: members } = useMembersQuery();
  const memberById = new Map<string, Member>(
    (members?.data?.members ?? []).map((m: Member) => [m.userId, m]),
  );

  return (
    <section className="flex flex-col gap-4">
      {/* The filter is where the roster went: a project with nothing on the
          board has no card, but it is still in this list, and picking it says
          so outright instead of leaving the project unreachable. */}
      <div className="flex items-center justify-between gap-3">
        {/* A step ABOVE the card titles, not two: it is a heading, but the
            cards are the content and it must not out-shout them.

            The tour anchors HERE rather than on the stack below: the heading
            is painted whether or not there is anything under it, and "nothing
            has run yet" is exactly when someone needs telling what this column
            is for. Anchored on the stack, the step vanished on an empty feed —
            `skipMissingElement` swallows it without a word. */}
        <h2
          className="text-lg font-medium text-foreground"
          data-tour={LAYOUT_TOUR_ANCHORS.recentActivity}
        >
          {t("home.projectFeed.heading")}
        </h2>
        <div className="flex items-center gap-2">
          {showFilter && (
            <ProjectFilter
              index={index}
              value={bucketId}
              onChange={setBucketId}
            />
          )}
          {action}
        </div>
      </div>
      {entries.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
          {t("home.projectFeed.empty")}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {entries.map((entry) => (
            <FeedCard
              key={entry.task.id}
              entry={entry}
              memberById={memberById}
            />
          ))}
        </div>
      )}
    </section>
  );
}
