/**
 * Task board — the org's own board of tasks (title,
 * description, status, priority, assignee), independent of chat threads.
 * Rendered as a main-panel overlay tab; there is no standalone route.
 */

import { useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { getInitials } from "@/lib/get-initials";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Button } from "@decocms/ui/components/button.tsx";
import { useT } from "@/i18n/use-t.ts";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import {
  AlertTriangle,
  Calendar,
  CheckCircle,
  ChevronRight,
  Columns03,
  DotsHorizontal,
  HelpCircle,
  Lightning01,
  List,
  Loading01,
  Plus,
  RefreshCw01,
  Repeat04,
  UserPlus01,
  X,
} from "@untitledui/icons";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { SuperAgentIcon } from "@/components/super-agent-icon";
import { LoaderCircle } from "lucide-react";
import { ReviewerIcon } from "@/components/reviewer-icon";
import {
  getWellKnownDecopilotVirtualMCP,
  useConnections,
  useProjectContext,
} from "@/sdk";
import {
  getRepoScope,
  listRepoScopeLabels,
} from "@decocms/shared/github-repo-scope";
import { GitHubRepoPicker } from "@/components/github-repo-picker";
import { useMembers } from "@/hooks/use-members";
import {
  useTaskBoardItemActions,
  useBoardColumns,
  useBoardSprintIndex,
  useTaskBoardItems,
} from "@/hooks/use-task-board-items";
import { formatTimeAgo } from "@/lib/format-time";
import {
  agentRunState,
  cardNeedsAttention,
  TASK_TYPE_CONFIG,
  type TaskBoardItemType,
  dueDateUrgency,
  insertSortOrder,
  isTaskBlocked,
  isTaskHandedToHuman,
  HIDDEN_STATUSES,
  laneVisibility,
  moveTargets,
  PRIORITIES,
  PRIORITY_CONFIG,
  runSortOrders,
  statusIconClassName,
  dropLane,
  LANE_DROPPABLE_PREFIX,
  type BoardColumn,
  laneHeader,
  laneVisual,
  SUPER_AGENT_ASSIGNEE_ID,
  tagDotColor,
  TASK_TYPES,
  type TaskBoardItem,
  type TaskBoardItemPriority,
  type TaskBoardItemTag,
  type Member,
} from "./config";
import { useTags } from "@/hooks/use-tags";
import {
  useOrgFlag,
  useReviewerEnabled,
} from "@/hooks/use-organization-settings";
import type { Sprint } from "@decocms/shared/sprints";
import { usePreferences } from "@/hooks/use-preferences";
import {
  TaskBoardItemDetail,
  TaskBoardItemDialog,
  toEndOfDayIso,
} from "./task-dialog";
import { AssigneePickerContent } from "./assignee-picker";
import { ConnectGitHubDialog } from "./connect-github-dialog";
import { SubscriptionPaywallDialog } from "./subscription-paywall-dialog";
import { RerunDialog } from "./rerun-dialog";
import { subscriptionErrorKind } from "@/components/task-board/is-subscription-error";
import { isReportsTask, type ReviewerKind } from "@decocms/shared/task-board";
import {
  type ChecksSummary,
  checksSummary,
  enabledReviewers,
} from "./review-status";
import { taskKey } from "@decocms/shared/task-key";
import { useFlipLanes } from "./use-flip-lanes";
import { Calendar as DayPickerCalendar } from "@decocms/ui/components/calendar.tsx";
import { buildTaskChatContext } from "./build-task-chat-context";
import { track } from "@/lib/posthog-client";
import { useStudioTools } from "@/lib/studio-tools";
import {
  EMPTY_FILTERS,
  resolveSprintFilter,
  TaskFiltersBar,
  TaskFiltersDrawer,
  taskMatchesFilters,
  type TaskFilters,
} from "./task-filters";
import { useBoardSearch } from "./filters-search";
import { usePanelActions } from "@/layouts/shell-layout";
import { Navigate, useNavigate, useParams } from "@tanstack/react-router";
import { DESTINATION_ROUTE } from "@/hooks/use-destination-route";
import {
  findTaskByKeyOrId,
  taskRouteSegment,
} from "@/layouts/task-board/task-route";
import { useThreadActions } from "@/components/chat/store/hooks";
import { writeChatDraft } from "@/lib/chat-draft";
import { createMentionDoc } from "@/components/chat/tiptap/mention";
import type { TiptapDoc } from "@/components/chat/types";
import { toast } from "sonner";

// Warm the chat chunk so opening a task's activity doesn't cold-load it (flash).
void import("../agent-shell-layout/index.tsx").catch(() => {});

const DATE_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

function formatDueDate(iso: string): { label: string; overdue: boolean } {
  const d = new Date(iso);
  const overdue = d.getTime() < Date.now();
  return { label: DATE_FMT.format(d), overdue };
}

/** Shared meta chip: an outlined pill, neutral border by default. */
const PILL =
  "inline-flex items-center gap-1 rounded-full border-[length:var(--border-hairline)] border-border px-2 py-0.5 text-xs font-medium text-muted-foreground";

/**
 * Footer glyph size. 12, not 14, because every icon here is drawn on a 24 grid:
 * 12 is exactly half, so strokes land on whole device pixels. At 14 the scale
 * is 7/12 and a two-line glyph like `Equal` straddles pixel boundaries in
 * mirrored proportions — one line smears up, the other down, and the pair reads
 * as a pixel out of true.
 */
const FOOTER_GLYPH = 12;

/** A footer property glyph. 14, not 16: the footer's text is 12, and a glyph that outweighs its own label reads as the subject rather than the annotation. */
const PROPERTY_GLYPH_CLASS = "size-3.5";

/** Tags a card shows before collapsing the rest into `+N`. Matches the list
 *  view's existing cap; the full set is in the task dialog. */
const CARD_TAG_LIMIT = 2;

/** Card flag for a task whose agent is paused waiting on human input. */
function BlockedBadge() {
  const t = useT();
  return (
    <span
      className={cn(PILL, "border-warning/50 text-warning")}
      title={t("taskBoard.taskBoard.blockedBadgeTitle")}
    >
      <HelpCircle size={FOOTER_GLYPH} />
      {t("taskBoard.taskBoard.needsInput")}
    </span>
  );
}

function HandedToHumanBadge() {
  const t = useT();
  return (
    <span
      className={cn(PILL, "border-warning/50 text-warning")}
      title={t("taskBoard.taskBoard.handedToHumanBadgeTitle")}
    >
      <HelpCircle size={FOOTER_GLYPH} />
      {t("taskBoard.taskBoard.needsYou")}
    </span>
  );
}

/** Priority as a single glyph: a tooltip when read-only, a picker when `onChange` is given. */
function PriorityIcon({
  priority,
  onChange,
}: {
  priority: TaskBoardItemPriority;
  onChange?: (priority: TaskBoardItemPriority) => void;
}) {
  const t = useT();
  const config = PRIORITY_CONFIG[priority];
  const label = t(config.labelKey);
  // Sized by class, not by `size`: inside a Button, `[&_svg]:size-4` beats the attribute.
  const glyph = (
    <config.icon
      className={cn(PROPERTY_GLYPH_CLASS, "shrink-0", config.iconClassName)}
      aria-label={label}
    />
  );
  if (!onChange) return <GlyphTooltip label={label}>{glyph}</GlyphTooltip>;
  return (
    <FooterGlyphMenu label={label} glyph={glyph}>
      {PRIORITIES.map((p) => {
        const Icon = PRIORITY_CONFIG[p].icon;
        return (
          <DropdownMenuItem
            key={p}
            onSelect={() => onChange(p)}
            className={cn("gap-2", p === priority && "bg-accent")}
          >
            <Icon
              size={FOOTER_GLYPH}
              className={cn("shrink-0", PRIORITY_CONFIG[p].iconClassName)}
            />
            {t(PRIORITY_CONFIG[p].labelKey)}
          </DropdownMenuItem>
        );
      })}
    </FooterGlyphMenu>
  );
}

/**
 * Turns a footer glyph into a Jira-style property picker: click the glyph,
 * pick a new value from the dropdown, stopping the click from also opening
 * the card (it's already a button) or starting a drag.
 */
function FooterGlyphMenu({
  label,
  glyph,
  children,
}: {
  label: string;
  glyph: ReactNode;
  children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          title={label}
          aria-label={label}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          // Cancels the button's 6px padding in the layout so it takes only its glyph's width: the row spaces itself off the glyph, and the leftover 6px is what the hover surface bleeds into.
          className="-m-1.5"
        >
          {glyph}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-36"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Hover label for a footer glyph.
 *
 * `asChild` over a span on purpose: `TooltipTrigger` renders a button by
 * default, and the card is already a button — nesting one inside it is a
 * hydration error. The span isn't focusable, so the glyph keeps its
 * `aria-label` for anyone not using a pointer.
 */
function GlyphTooltip({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex shrink-0 items-center">{children}</span>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

/** The card's kind, as one glyph. Shape carries it; the name is on hover. */
function TaskTypeIcon({
  type,
  onChange,
}: {
  type: TaskBoardItemType;
  onChange?: (type: TaskBoardItemType) => void;
}) {
  const t = useT();
  const config = TASK_TYPE_CONFIG[type];
  const label = t(config.labelKey);
  const glyph = (
    <config.icon
      className={cn(PROPERTY_GLYPH_CLASS, "shrink-0", config.iconClassName)}
      aria-label={label}
    />
  );
  if (!onChange) return <GlyphTooltip label={label}>{glyph}</GlyphTooltip>;
  return (
    <FooterGlyphMenu label={label} glyph={glyph}>
      {TASK_TYPES.map((tp) => {
        const Icon = TASK_TYPE_CONFIG[tp].icon;
        return (
          <DropdownMenuItem
            key={tp}
            onSelect={() => onChange(tp)}
            className={cn("gap-2", tp === type && "bg-accent")}
          >
            <Icon
              size={FOOTER_GLYPH}
              className={cn("shrink-0", TASK_TYPE_CONFIG[tp].iconClassName)}
            />
            {t(TASK_TYPE_CONFIG[tp].labelKey)}
          </DropdownMenuItem>
        );
      })}
    </FooterGlyphMenu>
  );
}

/**
 * A card's due date, in the footer. Shown whenever the card has one — the
 * footer is the row of fixed facts — but only coloured once it is close enough
 * to act on, so a date months out sits quiet instead of competing with the
 * overdue ones.
 */
function FooterDueDate({
  iso,
  onChange,
}: {
  iso: string;
  onChange?: (iso: string) => void;
}) {
  const urgency = dueDateUrgency(iso);
  const { label } = formatDueDate(iso);
  const content = (
    <>
      <Calendar className={PROPERTY_GLYPH_CLASS} />
      {label}
    </>
  );
  const tone = cn(
    "shrink-0 items-center gap-1.5 text-xs font-medium tabular-nums text-muted-foreground/70",
    urgency === "overdue" && "text-destructive",
    urgency === "soon" && "text-warning",
  );
  if (!onChange) return <span className={cn("flex", tone)}>{content}</span>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          // Matches the glyph buttons: the padding is hover surface only, so the row still spaces itself off the content.
          className={cn("-mx-1.5 h-auto px-1.5 py-1 font-medium", tone)}
        >
          {content}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-auto p-0"
        onClick={(e) => e.stopPropagation()}
      >
        <DayPickerCalendar
          mode="single"
          selected={new Date(iso)}
          defaultMonth={new Date(iso)}
          onSelect={(date) => date && onChange(toEndOfDayIso(date))}
          initialFocus
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The card's one run action, as a written footer button. Revealed on hover; its collapsed width keeps the resting footer uncluttered. */
function CardActionGlyph({
  action,
}: {
  action: { icon: typeof RefreshCw01; label: string; onClick: () => void };
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={action.label}
      onClick={(e) => {
        e.stopPropagation();
        action.onClick();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className="-my-1.5 h-7 gap-1.5 px-2 text-xs font-medium pointer-events-none opacity-0 transition-opacity focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
    >
      <action.icon className={PROPERTY_GLYPH_CLASS} />
      {action.label}
    </Button>
  );
}

/**
 * The card's baseline: its key, its priority, how far review got. Fixed height
 * and always present, so the eye finds the same three facts at the same offset
 * on every card in a lane — which is the whole point of the redesign.
 */
function CardFooter({
  item,
  checks,
  assignee,
  assignedBy,
  members,
  onAssign,
  onPriorityChange,
  onTypeChange,
  onDueDateChange,
  action,
}: {
  item: TaskBoardItem;
  checks: { summary: ChecksSummary; enabled: ReviewerKind[] } | null;
  action?: { icon: typeof RefreshCw01; label: string; onClick: () => void };
  assignee?: Member;
  assignedBy?: Member;
  members?: Member[];
  onAssign?: (userId: string | null) => void;
  onPriorityChange?: (priority: TaskBoardItemPriority) => void;
  onTypeChange?: (type: TaskBoardItemType) => void;
  onDueDateChange?: (iso: string) => void;
}) {
  const { org } = useProjectContext();
  const key = taskKey(org.slug, item.keySeq, item.jiraIssueKey);
  return (
    // No inset of its own: the footer shares the card's padding, so the type glyph starts on the same left edge as the title and the labels.
    <div className="mt-auto flex shrink-0 items-center justify-between gap-2 pt-1">
      {/* Each glyph binds to its own label at `gap-1.5`, and the pairs stand apart at `gap-3` — an icon spaced the same as its neighbours belongs to neither. */}
      <span className="flex min-w-0 items-center gap-3">
        <span className="flex shrink-0 items-center gap-1.5">
          <TaskTypeIcon type={item.type} onChange={onTypeChange} />
          <span className="text-xs font-medium tabular-nums text-muted-foreground/70">
            {key}
          </span>
        </span>
        {item.dueDate && (
          <FooterDueDate iso={item.dueDate} onChange={onDueDateChange} />
        )}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {action && <CardActionGlyph action={action} />}
        {(item.priority !== "none" || onPriorityChange) && (
          <PriorityIcon priority={item.priority} onChange={onPriorityChange} />
        )}
        {checks && (
          <ChecksChip
            summary={checks.summary}
            verdicts={item.reviewVerdicts}
            enabled={checks.enabled}
          />
        )}
        <AssigneeDisplay
          item={item}
          assignee={assignee}
          assignedBy={assignedBy}
          members={members}
          onAssign={onAssign}
          showDelegation={false}
        />
      </span>
    </div>
  );
}

/** List-row priority: dot + name. Cards use {@link PriorityIcon} instead. */
function PriorityPill({ priority }: { priority: TaskBoardItemPriority }) {
  const t = useT();
  const config = PRIORITY_CONFIG[priority];
  const label = t(config.labelKey);
  return (
    <span className={PILL} title={label}>
      <span
        className={cn("size-2 shrink-0 rounded-full", config.dotClassName)}
      />
      {label}
    </span>
  );
}

/** List-row due date. Cards use {@link FooterDueDate} instead. */
function DueDatePill({ iso }: { iso: string }) {
  const { label, overdue } = formatDueDate(iso);
  return (
    <span
      className={cn(PILL, overdue && "border-destructive/50 text-destructive")}
    >
      <Calendar size={FOOTER_GLYPH} />
      {label}
    </span>
  );
}

/** The sprint a card belongs to, named the way its tracker names it. */
function SprintPill({ sprint }: { sprint: Sprint }) {
  return (
    <span className={PILL}>
      <Repeat04 size={FOOTER_GLYPH} />
      {sprint.name}
    </span>
  );
}

/** The sprint of the card being rendered, or null when it's in the backlog. */
function useCardSprint(item: TaskBoardItem): Sprint | null {
  const sprints = useBoardSprintIndex();
  return item.sprintId ? (sprints.get(item.sprintId) ?? null) : null;
}

/** A tag wears its own color as a border, Jira-style — the color is the identity, no separate dot needed. */
function TagPill({ tag }: { tag: TaskBoardItemTag }) {
  return (
    <span
      className={cn(PILL, "text-foreground")}
      style={{ borderColor: tagDotColor(tag.color) }}
    >
      {tag.name}
    </span>
  );
}

/**
 * How far a card is through review, as one glyph: `1/2`.
 *
 * Replaces a footer row that named whichever agent thread ranked highest and
 * echoed its prose — which agent that was depended on run ordering, so a lane
 * headlined three different agents and none of them compared.
 *
 * Per-reviewer detail lives in the `title`: a card is already a button, so a
 * hover card here would nest interactive elements.
 */
function ChecksChip({
  summary,
  verdicts,
  enabled,
}: {
  summary: ChecksSummary;
  verdicts: TaskBoardItem["reviewVerdicts"];
  enabled: ReviewerKind[];
}) {
  const t = useT();
  // One row per reviewer, rather than a joined string — the whole point of a
  // real tooltip over a `title` is that it can be laid out.
  const detail = (
    <span className="flex flex-col gap-0.5">
      {enabled.map((kind) => {
        const verdict = verdicts.find((v) => v.reviewer === kind);
        const name = t("taskBoard.taskDialog.reviewerLabel");
        const state = !verdict
          ? t("taskBoard.taskBoard.checksPending")
          : verdict.verdict === "changes_requested"
            ? t("taskBoard.taskBoard.checksChangesRequested")
            : t(
                verdict.verified
                  ? "taskBoard.taskBoard.checksApproved"
                  : "taskBoard.taskBoard.checksUnverified",
              );
        return (
          <span
            key={kind}
            className="flex items-center gap-1.5 whitespace-nowrap"
          >
            <ReviewerIcon size={12} />
            {name} — {state}
          </span>
        );
      })}
    </span>
  );

  return (
    <GlyphTooltip label={detail}>
      <span
        className={cn(
          // Not a button, but it carries a property like one — so it wears the same glyph and the same 6px inset.
          "flex shrink-0 items-center gap-1.5 text-xs font-medium tabular-nums",
          summary.tone === "ok" && "text-success",
          summary.tone === "pending" && "text-warning",
          summary.tone === "danger" && "text-destructive",
        )}
        aria-label={t("taskBoard.taskBoard.checksLabel", {
          passed: String(summary.passed),
          total: String(summary.total),
        })}
      >
        <CheckCircle className={PROPERTY_GLYPH_CLASS} />
        {summary.passed}/{summary.total}
      </span>
    </GlyphTooltip>
  );
}

/**
 * Run state as a single dot: an agent is working, or one died. Small as it is,
 * the footer this card no longer has was the only place a failed run surfaced.
 */
function AgentRunIndicator({ state }: { state: "running" | "failed" }) {
  const t = useT();
  const running = state === "running";
  const label = t(
    running
      ? "taskBoard.taskBoard.agentRunning"
      : "taskBoard.taskBoard.agentFailed",
  );
  // LoaderCircle, not the board's `Loading01`: that one is eight evenly-spaced
  // spokes, so rotating it lands on an identical image every 45° and
  // `animate-spin` reads as a still frame. An arc has to be asymmetric to look
  // like it is turning.
  const Icon = running ? LoaderCircle : AlertTriangle;
  return (
    <span className="mt-px flex shrink-0 items-center">
      <GlyphTooltip label={label}>
        <Icon
          size={14}
          className={cn(
            "shrink-0",
            running ? "animate-spin text-primary" : "text-destructive",
          )}
          aria-label={label}
        />
      </GlyphTooltip>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * The card's checks indicator, or null when there is nothing to say: this org
 * runs no reviewers, or the task has not reached review yet (a To Do card with
 * `0/1` would be reporting a failure that hasn't had a chance to happen).
 *
 * "Reached review" is the open cycle, not the In Review lane. Since migration
 * 189 a card whose reviewer is working reads In Progress, and that is exactly
 * when the pending chip earns its place — the lane alone would hide the checks
 * for the whole time they are actually being decided.
 */
function useCardChecks(item: TaskBoardItem): {
  summary: ChecksSummary;
  enabled: ReviewerKind[];
} | null {
  const enabled = enabledReviewers(useReviewerEnabled());
  if (
    item.reviewVerdicts.length === 0 &&
    item.status !== "in_review" &&
    !item.reviewCycleStartedAt
  ) {
    return null;
  }
  const summary = checksSummary(item.reviewVerdicts, enabled);
  return summary ? { summary, enabled } : null;
}

/**
 * Assignee glyph for a card/row. For a Super Agent task it renders the
 * delegation as overlapping avatars — the assigner's avatar eclipsed by the
 * Super Agent capybara — so it's clear a human handed the task off. Otherwise a
 * plain member avatar.
 *
 * `showDelegation` is off on board cards — repeated down a lane the capybara says
 * nothing the pulse dot and checks don't. A list row has no lane, so it keeps it.
 */
function AssigneeDisplay({
  item,
  assignee,
  assignedBy,
  members,
  onAssign,
  showDelegation = true,
}: {
  item: TaskBoardItem;
  assignee?: Member;
  assignedBy?: Member;
  members?: Member[];
  onAssign?: (userId: string | null) => void;
  showDelegation?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  if (item.assigneeId === SUPER_AGENT_ASSIGNEE_ID) {
    const title = assignedBy?.user?.name
      ? t("taskBoard.taskBoard.assignedToSuperAgentBy", {
          name: assignedBy.user.name,
        })
      : t("taskBoard.taskBoard.assignedToSuperAgent");
    if (!showDelegation) {
      return assignedBy ? (
        <Avatar
          url={assignedBy.user?.image ?? undefined}
          fallback={getInitials(assignedBy.user?.name)}
          shape="circle"
          size="xs"
          title={title}
        />
      ) : null;
    }
    return (
      <span className="inline-flex items-center" title={title}>
        {assignedBy && (
          <Avatar
            url={assignedBy.user?.image ?? undefined}
            fallback={getInitials(assignedBy.user?.name)}
            shape="circle"
            size="xs"
            className="-mr-2 ring-2 ring-background"
          />
        )}
        <SuperAgentIcon size={20} className="ring-2 ring-background" />
      </span>
    );
  }
  if (assignee) {
    return (
      <Avatar
        url={assignee.user?.image ?? undefined}
        fallback={getInitials(assignee.user?.name)}
        shape="circle"
        size="xs"
      />
    );
  }
  if (!onAssign || !members?.length) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={t("taskBoard.taskBoard.assignButton")}
          aria-label={t("taskBoard.taskBoard.assignButton")}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
          className="flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed border-muted-foreground/40 text-muted-foreground/40 transition-colors hover:border-muted-foreground hover:text-muted-foreground"
        >
          <UserPlus01 size={13} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-56 p-0"
        align="end"
        side="bottom"
        onClick={(e) => e.stopPropagation()}
      >
        <AssigneePickerContent
          members={members}
          onSelect={(userId) => {
            onAssign(userId);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

export function TaskBoardPage() {
  const t = useT();
  const { items, sprints, columns, isLoading } = useTaskBoardItems();
  const { data: orgTags = [] } = useTags();
  const actions = useTaskBoardItemActions();
  // Handing a task to the Super Agent makes it open a PR — so it needs at
  // least one repo imported (a repo-scoped mcp-github connection; the bare
  // org-level connection has no `repoScope` and isn't loadable). Every path that
  // assigns to the Super Agent (Auto-fix, the lane assignee picker, the task
  // dialog) prompts to connect + pick a repo instead of enqueueing a run that
  // has nothing to load.
  // Mirrors `load_repo`'s `selectLoadableRepos` (apps/api): the Super Agent's
  // built-in loads ANY active repo-scoped `mcp-github` connection — org-shared
  // OR per-agent (e.g. a repo imported by a Code Agent). So an existing
  // per-agent connection already satisfies this; don't force a fresh connect.
  const githubConnections = useConnections({ slug: "mcp-github" }) ?? [];
  const hasRepo = githubConnections.some(
    (c) => c.status === "active" && getRepoScope(c) !== null,
  );
  // Repo filter options: distinct `owner/name` repos the org can reach.
  const repos = listRepoScopeLabels(githubConnections);
  const [connectGithubOpen, setConnectGithubOpen] = useState(false);
  // Connecting only grants a broad org-level GitHub connection — Auto-fix
  // still needs a repo imported (see `hasRepo`), so once connected we chain
  // straight into the repo picker.
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);
  // Returns true if the assignment was blocked (connect prompt opened) so the
  // caller stops before dispatching.
  const blockSuperAgentWithoutGithub = (
    assigneeId: string | null | undefined,
  ) => {
    if (assigneeId === SUPER_AGENT_ASSIGNEE_ID && !hasRepo) {
      setConnectGithubOpen(true);
      return true;
    }
    return false;
  };
  // Set when delegating to the Super Agent (dialog submit or the lane/card
  // assignee picker) is rejected with a `[SUBSCRIPTION_REQUIRED]` error — see
  // `subscriptionErrorKind`'s 3 cases. Both delegation paths funnel through
  // `actions.update`, so a single per-call `onError` here covers both.
  const [subscriptionPaywall, setSubscriptionPaywall] =
    useState<ReturnType<typeof subscriptionErrorKind>>(null);
  // Anything that is not the paywall gets a toast: these tools refuse with a
  // sentence written for the user (a re-run whose merge is still retrying, a
  // card not assigned to the Super Agent), and dropping it made the button look
  // broken — the click did nothing and the reason only reached the Network tab.
  const onDelegateError = (err: Error) => {
    const kind = subscriptionErrorKind(err);
    if (kind) {
      setSubscriptionPaywall(kind);
      track("task_limit_banner_shown", { organization_id: org.id, kind });
      return;
    }
    toast.error(err.message || t("taskBoard.taskBoard.actionError"));
  };
  // Ref, not an effect: fires once per mount, `tracked` guards a re-invoked ref.
  const trackBoardOpenRef = (element: HTMLDivElement | null) => {
    if (!element || element.dataset.tracked === "true") return;
    element.dataset.tracked = "true";
    track("task_board_opened", { organization_id: org.id });
  };
  // The task awaiting a re-run confirmation, or null. A re-run supersedes the
  // task's live run, so it is confirmed rather than fired on click.
  // One entry for a card's own Re-run, many for a selection.
  const [rerunTargets, setRerunTargets] = useState<TaskBoardItem[]>([]);
  const confirmRerun = () => {
    if (rerunTargets.length === 0) return;
    // Same GitHub precondition as delegating: the run is expected to open a PR.
    if (blockSuperAgentWithoutGithub(SUPER_AGENT_ASSIGNEE_ID)) {
      setRerunTargets([]);
      return;
    }
    // ponytail: fire-and-forget per task, like every other bulk action here —
    // the board reconciles from the invalidation each one triggers.
    for (const target of rerunTargets)
      actions.rerun.mutate(
        { id: target.id },
        { onError: (err) => onDelegateError(err as Error) },
      );
    setRerunTargets([]);
    clearSelection();
  };
  const { data: membersData } = useMembers();
  const members = (membersData?.data?.members ?? []) as Member[];
  const memberByUserId = new Map(members.map((m) => [m.userId, m]));

  // Filters + layout live in the URL, so a refresh or a shared link keeps them.
  const {
    filters: urlFilters,
    setFilters,
    layout,
    setLayout,
  } = useBoardSearch();
  // A URL outlives the sprint it names, so an unknown one is dropped rather
  // than left hiding every card behind a chip that reads like "no filter".
  const filters = isLoading
    ? urlFilters
    : {
        ...urlFilters,
        sprint: resolveSprintFilter(urlFilters.sprint, sprints),
      };
  const [preferences] = usePreferences();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggleSelect = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectAllInLane = (status: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const item of visibleItems)
        if (item.status === status) next.add(item.id);
      return next;
    });
  const clearSelection = () => setSelectedIds(new Set());
  // A filter change can hide selected cards the same way the list-view toggle does.
  const handleFiltersChange = (next: TaskFilters) => {
    setFilters(next);
    clearSelection();
  };
  // Create only: an existing card is addressed by its path, not by state.
  const [dialogOpen, setDialogOpen] = useState(false);
  // Status a newly-created task should start in (set by a lane's "+"); null for
  // the generic "New task" button.
  const [createStatus, setCreateStatus] = useState<string | null>(null);
  const { setTaskId } = usePanelActions();
  const { create } = useThreadActions();
  const studio = useStudioTools();
  const { org, locator } = useProjectContext();
  const navigate = useNavigate();
  const openBoardSettings = () => {
    navigate({
      to: "/$org/settings/task-board",
      params: { org: org.slug },
    });
  };
  /**
   * `/$org/tasks/DECO-01` renders that card in place of the lanes — the one
   * address a task has, whether it was reached by clicking its card, by the
   * short `/$org/t/DECO-01` link, or by a legacy `?task=`.
   *
   * The segment is the whole of the open-task state: resolving the row out of
   * the SSE-patched list on every render is what lets a thread or status
   * linked while the task is on screen flow straight in.
   *
   * `strict: false` because the board also renders as an overlay view
   * on destinations that have no such param, where it reads `undefined` and
   * shows the lanes.
   */
  const { taskKey: openTaskKey } = useParams({ strict: false }) as {
    taskKey?: string;
  };
  const openItem = findTaskByKeyOrId(items, openTaskKey) ?? null;
  /** A deleted (or never-visible) card leaves the segment dangling; land on
   *  the board rather than an empty pane. */
  const staleTaskKey = !!openTaskKey && !openItem && !isLoading;
  /** The key the card actually wears, so a link minted from an id or from
   *  `deco-1` settles on the shareable form instead of preserving whatever
   *  spelling it arrived as. */
  const canonicalKey = openItem ? taskRouteSegment(org.slug, openItem) : null;

  /**
   * Leaving a task replaces its entry rather than stacking a second one.
   * Opening pushes, so back from a task lands on the board; if closing pushed
   * too, back from the board would re-open the task just closed, and a cycle
   * of opens would bury the page the board was reached from.
   */
  const closeTask = () => {
    if (openTaskKey)
      navigate({
        to: DESTINATION_ROUTE.tasks,
        params: { org: org.slug, taskKey: undefined },
        search: (prev: Record<string, unknown>) => prev,
        replace: true,
      });
  };

  // Start a fresh chat on the default Decopilot agent, seeded with the task's
  // title + description as the first user message (via the autosend buffer),
  // and link the new thread to the task so it shows on the modal.
  const startChatFromTask = async (task: TaskBoardItem) => {
    const newId = crypto.randomUUID();
    const agentId = getWellKnownDecopilotVirtualMCP(org.id).id;
    // Pull the task's linked PRs (best-effort — the chat still opens without
    // them) so the seeded context references prior work, not just the title.
    const prs = await studio
      .call("TASK_BOARD_ITEM_PRS_GET", { taskBoardItemId: task.id })
      .then((r) => r.prs)
      .catch(() => []);
    const context = buildTaskChatContext(task, prs);
    // Prefill the composer with a removable task @ref chip (not raw text) and
    // do NOT auto-send — the user reviews/adds to it, then hits send. The chip
    // expands to the task context at send time (see derive-parts).
    const doc: TiptapDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            createMentionDoc({
              id: task.id,
              name: task.title,
              char: "@",
              kind: "task",
              metadata: {
                title: task.title,
                description: task.description,
                context,
              },
            }),
            { type: "text", text: " " },
          ],
        },
      ],
    };
    writeChatDraft(sessionStorage, locator, newId, doc);
    try {
      await create({ id: newId, virtual_mcp_id: agentId });
      // Best-effort — a link failure shouldn't block navigating into the chat.
      await actions.link.mutateAsync({ id: task.id, linkThreadId: newId });
    } catch {
      // Toast already fired by the manager; navigate anyway so the route
      // loader's ensure-fallback can retry the create.
    }
    setTaskId(newId, agentId);
  };

  const visibleItems = items.filter((item) =>
    taskMatchesFilters(item, filters),
  );
  // The list view has no "Hidden columns" drawer, so it drops hidden lanes outright.
  const visibleListItems = visibleItems.filter(
    (item) =>
      !HIDDEN_STATUSES.includes(item.status) ||
      preferences.shownTaskBoardLanes.includes(item.status),
  );

  const openCreate = () => {
    setCreateStatus(null);
    setDialogOpen(true);
  };

  const openCreateInLane = (status: string) => {
    setCreateStatus(status);
    setDialogOpen(true);
  };

  /**
   * Open a card: a navigation to the card's own URL, not a modal. Pushed
   * rather than replaced so browser back lands on the board the card was
   * clicked from.
   *
   * Named as the tasks route rather than `"."` because the board also renders
   * as an overlay view elsewhere, and a card has exactly one address
   * wherever it was clicked. The board's filters ride along; anything the
   * tasks route does not declare is dropped by its schema.
   */
  const openTask = (item: TaskBoardItem) => {
    navigate({
      to: DESTINATION_ROUTE.tasks,
      params: { org: org.slug, taskKey: taskRouteSegment(org.slug, item) },
      search: (prev: Record<string, unknown>) => prev,
    });
  };

  const closeCreate = () => {
    setDialogOpen(false);
    setCreateStatus(null);
  };

  if (isLoading && items.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loading01 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (staleTaskKey) {
    return (
      <Navigate
        to={DESTINATION_ROUTE.tasks}
        params={{ org: org.slug, taskKey: undefined }}
        search={(prev: Record<string, unknown>) => prev}
        replace
      />
    );
  }

  if (canonicalKey && canonicalKey !== openTaskKey) {
    return (
      <Navigate
        to={DESTINATION_ROUTE.tasks}
        params={{ org: org.slug, taskKey: canonicalKey }}
        search={(prev: Record<string, unknown>) => prev}
        replace
      />
    );
  }

  /** The board itself — header, toolbar, lanes. Hoisted so wrapping it
   *  below does not reindent every line of it. */
  const boardContent = (
    <>
      {/* Header — capped + centered to the same width as the board content so
        they line up; content-capped, not scroll-capped. */}
      <div className="mx-auto flex w-full max-w-[1680px] flex-col gap-4 px-4 pt-6 sm:px-8 sm:pt-8">
        <h1 className="text-xl font-medium text-foreground">
          {t("taskBoard.taskBoard.tasksTitle")}
        </h1>

        {/* Commerce orgs: a persistent unlock CTA that self-hides once the
          diagnostic is paid. The board stays usable in the meantime. */}

        {/* Toolbar — filters on the left (inline bar on desktop, a single
          drawer button on mobile), view toggle + New task on the right. */}
        <div className="flex flex-wrap items-center gap-2">
          {items.length > 0 && (
            <>
              <div className="sm:hidden">
                <TaskFiltersDrawer
                  filters={filters}
                  members={members}
                  tags={orgTags}
                  repos={repos}
                  sprints={sprints}
                  onChange={handleFiltersChange}
                  onOpenBoardSettings={openBoardSettings}
                />
              </div>
              <div className="hidden sm:block">
                <TaskFiltersBar
                  filters={filters}
                  members={members}
                  tags={orgTags}
                  repos={repos}
                  sprints={sprints}
                  onChange={handleFiltersChange}
                  onOpenBoardSettings={openBoardSettings}
                />
              </div>
            </>
          )}

          <div className="ml-auto flex items-center gap-2">
            <div className="inline-flex rounded-lg bg-muted p-0.5">
              <LayoutToggle
                active={layout === "list"}
                onClick={() => {
                  setLayout("list");
                  // Selection is a board-only concept (List has no way to see
                  // or change which cards are selected) — leaving it wedges
                  // the floating bulk-action bar on-screen, operating on a
                  // selection the user can no longer see.
                  clearSelection();
                }}
                icon={List}
                label={t("common.taskBoard.listView")}
              />
              <LayoutToggle
                active={layout === "board"}
                onClick={() => setLayout("board")}
                icon={Columns03}
                label={t("common.taskBoard.boardView")}
              />
            </div>

            <Button size="sm" onClick={openCreate}>
              <Plus size={16} />
              {t("taskBoard.taskBoard.newTask")}
            </Button>
          </div>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="mx-auto w-full max-w-[1680px] px-4 pt-6 sm:px-8">
          <div className="rounded-xl bg-card px-4 py-12 text-center text-sm text-muted-foreground card-shadow">
            {t("taskBoard.taskBoard.noTasksYet")}
          </div>
        </div>
      ) : visibleItems.length === 0 ? (
        <div className="mx-auto w-full max-w-[1680px] px-4 pt-6 sm:px-8">
          <div className="flex flex-col items-center gap-3 rounded-xl bg-card px-4 py-12 text-center text-sm text-muted-foreground card-shadow">
            {t("taskBoard.taskBoard.noTasksMatch")}
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleFiltersChange(EMPTY_FILTERS)}
            >
              {t("taskBoard.taskBoard.clearFilters")}
            </Button>
          </div>
        </div>
      ) : layout === "board" ? (
        <Lanes
          visible={!openItem}
          columns={columns}
          items={visibleItems}
          members={members}
          memberByUserId={memberByUserId}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onSelectAllInLane={selectAllInLane}
          onOpen={openTask}
          onCreate={openCreateInLane}
          onMove={(ids, status, sortOrder) => {
            // Cards dragged together land as a consecutive run ending at the
            // drop point, keeping `ids` order.
            const orders = runSortOrders(sortOrder, ids.length);
            ids.forEach((id, i) =>
              actions.update.mutate({
                id,
                status,
                sortOrder: orders[i]!,
              }),
            );
          }}
          onAssign={(id, userId) => {
            if (blockSuperAgentWithoutGithub(userId)) return;
            // `userId` is `null` for "Unassigned" — `?? undefined` used to
            // coalesce that into "field not provided", silently no-opping the
            // unassign since TASK_BOARD_ITEM_UPDATE treats undefined as
            // unchanged. `assigneeId` is nullable in the update schema, so
            // pass `userId` through as-is.
            actions.update.mutate(
              { id, assigneeId: userId },
              { onError: onDelegateError },
            );
          }}
          onPriorityChange={(id, priority) =>
            actions.update.mutate({ id, priority })
          }
          onTypeChange={(id, type) => actions.update.mutate({ id, type })}
          onDueDateChange={(id, dueDate) =>
            actions.update.mutate({ id, dueDate })
          }
          onAutoFix={(item) => {
            if (blockSuperAgentWithoutGithub(SUPER_AGENT_ASSIGNEE_ID)) return;
            actions.update.mutate(
              {
                id: item.id,
                assigneeId: SUPER_AGENT_ASSIGNEE_ID,
              },
              { onError: onDelegateError },
            );
          }}
          onRerun={(item) => setRerunTargets([item])}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-6 pb-16 sm:px-8">
          <div className="mx-auto flex max-w-[820px] flex-col gap-2">
            {visibleListItems.map((item) => (
              <ListRow
                key={item.id}
                item={item}
                assignee={
                  item.assigneeId
                    ? memberByUserId.get(item.assigneeId)
                    : undefined
                }
                assignedBy={
                  item.assignedBy
                    ? memberByUserId.get(item.assignedBy)
                    : undefined
                }
                onOpen={() => openTask(item)}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );

  /** Full-width so each region's scroll container spans the whole panel — the
   *  max-width lives on the *content* inside (header + lanes), so the mouse can
   *  sit in the empty margins on wide monitors and still scroll the board. */
  return (
    <div
      ref={trackBoardOpenRef}
      className="relative flex min-h-0 flex-1 flex-col"
    >
      {/* Hidden rather than unmounted while a task is open: lane scroll, the
          horizontal board scroll and dnd-kit's state all survive the trip into
          a card and back. `useFlipLanes` is told to stop measuring — a
          display:none board reports every card at 0×0. */}
      <div className={cn("flex min-h-0 flex-1 flex-col", openItem && "hidden")}>
        {boardContent}
      </div>

      {/* Keyed by id so switching cards (a deep link changing under us) starts
          the editor's form over rather than carrying the last one's fields. */}
      {openItem && (
        <TaskBoardItemDetail
          key={openItem.id}
          item={openItem}
          onClose={() => closeTask()}
          isSaving={actions.update.isPending}
          onSubmit={(input) => {
            if (blockSuperAgentWithoutGithub(input.assigneeId)) {
              closeTask();
              return;
            }
            /* Reports tasks own their title/description/priority in the
               reports sync, and TASK_BOARD_ITEM_UPDATE 500s on a write that
               touches them. The editor locks those fields but still
               round-trips their values, so drop them here; board fields
               (status/assignee/dueDate/tagIds) always go through. */
            const { title, description, priority, ...boardFields } = input;
            const contentFields = isReportsTask(openItem)
              ? {}
              : { title, description, priority };
            actions.update.mutate(
              { id: openItem.id, ...boardFields, ...contentFields },
              { onError: onDelegateError },
            );
          }}
          onDelete={() => {
            actions.remove.mutate(openItem.id);
            closeTask();
          }}
          onClone={() => {
            // A copy starts fresh and undelegated: no assignee, no threads.
            actions.create.mutate({
              title: t("taskBoard.taskDialog.cloneTitle", {
                title: openItem.title,
              }),
              description: openItem.description,
              status: openItem.status,
              priority: openItem.priority,
              repo: openItem.repo,
              dueDate: openItem.dueDate,
              tagIds: openItem.tags.map((tag) => tag.id),
            });
            toast.success(t("taskBoard.taskDialog.cloneSuccess"));
            closeTask();
          }}
          onArchive={() => {
            actions.update.mutate({ id: openItem.id, status: "archived" });
            toast.success(t("taskBoard.taskDialog.archiveSuccess"));
            closeTask();
          }}
          onNewChat={() => void startChatFromTask(openItem)}
          onAutoFix={() => {
            if (blockSuperAgentWithoutGithub(SUPER_AGENT_ASSIGNEE_ID)) return;
            actions.update.mutate(
              { id: openItem.id, assigneeId: SUPER_AGENT_ASSIGNEE_ID },
              { onError: onDelegateError },
            );
            closeTask();
          }}
          onRerun={() => {
            /* Confirm in the shared dialog rather than firing from here — the
               card path does the same, so the takeover warning has one home. */
            closeTask();
            setRerunTargets([openItem]);
          }}
          /* Only the PR card's "Edit" reaches this now — it opens the branch's
             live dev server, which is a place. A run's transcript opens in a
             sheet on the page instead. `setTaskId` builds a fresh search, so
             `task` falls away with it. */
          onOpenPreview={(thread) => {
            if (!thread.virtualMcpId) return;
            setTaskId(thread.threadId, thread.virtualMcpId, {
              panel: "preview",
            });
          }}
        />
      )}

      <TaskBoardItemDialog
        key={dialogOpen ? `new-${createStatus ?? "default"}` : "closed"}
        open={dialogOpen}
        onClose={closeCreate}
        defaultStatus={createStatus ?? undefined}
        isSaving={actions.create.isPending}
        onSubmit={(input) => {
          if (blockSuperAgentWithoutGithub(input.assigneeId)) {
            closeCreate();
            return;
          }
          actions.create.mutate(input);
          closeCreate();
        }}
      />

      <ConnectGitHubDialog
        open={connectGithubOpen}
        onOpenChange={setConnectGithubOpen}
        onConnected={() => setRepoPickerOpen(true)}
      />
      <GitHubRepoPicker
        mode="connection"
        open={repoPickerOpen}
        onOpenChange={setRepoPickerOpen}
      />

      <SubscriptionPaywallDialog
        kind={subscriptionPaywall}
        onOpenChange={(open) => !open && setSubscriptionPaywall(null)}
      />

      <RerunDialog
        items={rerunTargets}
        pending={actions.rerun.isPending}
        onOpenChange={(open) => !open && setRerunTargets([])}
        onConfirm={confirmRerun}
      />

      {/* Acts on the lanes, so it follows them out of view — the selection is
          kept, not cleared, and comes back with the board. */}
      {selectedIds.size > 0 && !openItem && (
        <SelectionBar
          count={selectedIds.size}
          members={members}
          onMoveTo={(status) => {
            for (const id of selectedIds) actions.update.mutate({ id, status });
            clearSelection();
          }}
          onSetPriority={(priority) => {
            for (const id of selectedIds)
              actions.update.mutate({ id, priority });
            clearSelection();
          }}
          onAddTag={(tagId) => {
            for (const id of selectedIds) {
              const item = items.find((i) => i.id === id);
              if (!item) continue;
              const tagIds = item.tags.map((tag) => tag.id);
              if (tagIds.includes(tagId)) continue;
              actions.update.mutate({ id, tagIds: [...tagIds, tagId] });
            }
            clearSelection();
          }}
          onAssign={(userId) => {
            if (blockSuperAgentWithoutGithub(userId)) return;
            for (const id of selectedIds)
              actions.update.mutate(
                { id, assigneeId: userId },
                { onError: onDelegateError },
              );
            clearSelection();
          }}
          onSetDueDate={(date) => {
            const dueDate = toEndOfDayIso(date);
            for (const id of selectedIds)
              actions.update.mutate({ id, dueDate });
            clearSelection();
          }}
          onAutoFix={
            selectedIds.size > 0 &&
            Array.from(selectedIds).every((id) => {
              const item = items.find((i) => i.id === id);
              return (
                item &&
                (item.status === "triage" || item.status === "todo") &&
                item.assigneeId !== SUPER_AGENT_ASSIGNEE_ID
              );
            })
              ? () => {
                  if (blockSuperAgentWithoutGithub(SUPER_AGENT_ASSIGNEE_ID))
                    return;
                  for (const id of selectedIds)
                    actions.update.mutate(
                      { id, assigneeId: SUPER_AGENT_ASSIGNEE_ID },
                      { onError: onDelegateError },
                    );
                  clearSelection();
                }
              : undefined
          }
          onRerun={
            // Same eligibility as a card's own Re-run button: delegated to the
            // Super Agent and not Done. Offered only when every selected card
            // qualifies, so the action never silently skips part of a selection.
            (() => {
              const targets = Array.from(selectedIds).flatMap((id) => {
                const item = items.find((i) => i.id === id);
                return item ? [item] : [];
              });
              return targets.length === selectedIds.size &&
                targets.every(
                  (item) =>
                    item.assigneeId === SUPER_AGENT_ASSIGNEE_ID &&
                    item.status !== "done",
                )
                ? () => setRerunTargets(targets)
                : undefined;
            })()
          }
          onDelete={() => {
            actions.removeMany.mutate(Array.from(selectedIds));
            clearSelection();
          }}
          onClear={clearSelection}
        />
      )}
    </div>
  );
}

/**
 * Small prompt shown when Auto-fix is used in an org with no GitHub connection.
 * The Super Agent needs GitHub to open a PR, so we connect first. Once the
 * connection lands the card's Auto-fix button works on the next click.
 */
/**
 * Floating pill toolbar that appears once at least one card is selected —
 * count, a bulk "Actions" menu (move / tag / priority / delete), a quick
 * "move to" shortcut, and a close button that clears the selection.
 */
function SelectionBar({
  count,
  members,
  onMoveTo,
  onSetPriority,
  onAddTag,
  onAssign,
  onSetDueDate,
  onAutoFix,
  onRerun,
  onDelete,
  onClear,
}: {
  count: number;
  members: Member[];
  onMoveTo: (status: string) => void;
  onSetPriority: (priority: TaskBoardItemPriority) => void;
  onAddTag: (tagId: string) => void;
  onAssign: (userId: string | null) => void;
  onSetDueDate: (date: Date) => void;
  /** Bulk-assign to the Super Agent — only offered when every selected card
   *  is still in Backlog/To Do (see `TaskBoardPage`). */
  onAutoFix?: () => void;
  /** Bulk re-run — only offered when every selected card is a Super Agent card
   *  that isn't Done (see `TaskBoardPage`). */
  onRerun?: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const t = useT();
  const { data: orgTags = [] } = useTags();
  const deliveryEnabled = useOrgFlag("delivery_lanes_enabled");
  const columns = useBoardColumns();
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 z-20 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-2 rounded-full bg-background px-3 py-2 card-shadow">
        <span className="pl-1 text-sm font-medium text-foreground">
          {t("taskBoard.taskBoard.selectedCount", { count })}
        </span>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              {t("taskBoard.taskBoard.actionsButton")}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" side="top">
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                {t("taskBoard.taskBoard.moveToButton")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {moveTargets(columns, deliveryEnabled).map((status) => (
                  <DropdownMenuItem
                    key={status}
                    onClick={() => onMoveTo(status)}
                  >
                    {laneHeader(status, t, columns).label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                {t("taskBoard.taskBoard.changePriorityButton")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {PRIORITIES.map((priority) => (
                  <DropdownMenuItem
                    key={priority}
                    onClick={() => onSetPriority(priority)}
                  >
                    <span
                      className={cn(
                        "size-2 rounded-full",
                        PRIORITY_CONFIG[priority].dotClassName,
                      )}
                    />
                    {t(PRIORITY_CONFIG[priority].labelKey)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                {t("taskBoard.taskBoard.assignButton")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-56 p-0">
                <AssigneePickerContent members={members} onSelect={onAssign} />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                {t("taskBoard.taskBoard.dueDateButton")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-auto p-0">
                <DayPickerCalendar
                  mode="single"
                  onSelect={(date) => date && onSetDueDate(date)}
                  initialFocus
                />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {orgTags.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  {t("taskBoard.taskBoard.addTagButton")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {orgTags.map((tag) => (
                    <DropdownMenuItem
                      key={tag.id}
                      onClick={() => onAddTag(tag.id)}
                    >
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: tagDotColor(tag.color) }}
                      />
                      {tag.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              {t("taskBoard.taskBoard.deleteSelectedButton")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {onAutoFix && (
          <button
            type="button"
            onClick={onAutoFix}
            className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            <Lightning01 size={14} />
            {t("taskBoard.taskBoard.autoFix")}
          </button>
        )}

        {onRerun && (
          <button
            type="button"
            onClick={onRerun}
            className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            <RefreshCw01 size={14} />
            {t("taskBoard.taskBoard.rerun")}
          </button>
        )}

        <button
          type="button"
          aria-label={t("taskBoard.taskBoard.clearSelectionButton")}
          title={t("taskBoard.taskBoard.clearSelectionButton")}
          onClick={onClear}
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

function LayoutToggle({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof List;
  label: string;
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t("taskBoard.taskBoard.layoutViewAriaLabel", { label })}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon size={14} />
      {label}
    </button>
  );
}

/** Where a card sits locally: while a drag is in flight, and then until the
 *  server's optimistic patch catches up. */
interface Placement {
  status: string;
  sortOrder: number;
}

/** Bits `useSortable` hands back that have to land on the card's own element
 *  for it to be draggable. Derived from the hook so there's no deep import. */
type SortableBindings = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners"
>;

function bySortOrder(a: TaskBoardItem, b: TaskBoardItem) {
  return a.sortOrder - b.sortOrder;
}

function Lanes({
  columns,
  items,
  members,
  memberByUserId,
  selectedIds,
  onToggleSelect,
  onSelectAllInLane,
  onOpen,
  onCreate,
  onMove,
  onAutoFix,
  onRerun,
  onAssign,
  onPriorityChange,
  onTypeChange,
  onDueDateChange,
  visible,
}: {
  /** The board's own columns, as the server sent them. */
  columns: readonly BoardColumn[];
  items: TaskBoardItem[];
  members: Member[];
  memberByUserId: Map<string, Member>;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onSelectAllInLane: (status: string) => void;
  onOpen: (item: TaskBoardItem) => void;
  onCreate: (status: string) => void;
  onMove: (ids: string[], status: string, sortOrder: number) => void;
  onAutoFix?: (item: TaskBoardItem) => void;
  onRerun?: (item: TaskBoardItem) => void;
  onAssign?: (id: string, userId: string | null) => void;
  onPriorityChange?: (id: string, priority: TaskBoardItemPriority) => void;
  onTypeChange?: (id: string, type: TaskBoardItemType) => void;
  onDueDateChange?: (id: string, iso: string) => void;
  /** False while the task detail has the panel — see `useFlipLanes`. */
  visible: boolean;
}) {
  const deliveryEnabled = useOrgFlag("delivery_lanes_enabled");
  const [activeId, setActiveId] = useState<string | null>(null);
  // Cards that just landed from a drop — they get the settle animation. Cleared
  // on drag start so dropping the same card twice replays it (a CSS animation
  // only re-runs when the class is removed and re-added).
  const [landedIds, setLandedIds] = useState<string[]>([]);
  // Local placement overrides, doing two jobs with one mechanism:
  //   1. Live preview — while dragging across lanes the card is rendered into
  //      the lane under the cursor, which is what makes dnd-kit's sortable
  //      strategy open a gap there.
  //   2. Bridge — after the drop they hold the new placement until the
  //      mutation's optimistic cache patch lands, so a card never flicks back
  //      to its old lane for a frame.
  // Entries retire themselves once `items` reports the same placement.
  const [overrides, setOverrides] = useState<Map<string, Placement>>(new Map());
  const [preferences, setPreferences] = usePreferences();
  const boardRef = useRef<HTMLDivElement>(null);

  // Converts a plain mouse wheel into horizontal board scroll, but only outside lanes.
  const attachBoard = (node: HTMLDivElement | null) => {
    boardRef.current = node;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      // Trackpad / Shift+wheel already produce a horizontal delta.
      if (event.deltaX !== 0 || event.deltaY === 0) return;
      if (node.scrollWidth <= node.clientWidth) return;
      for (
        let el = event.target as HTMLElement | null;
        el && el !== node;
        el = el.parentElement
      ) {
        if (el.hasAttribute("data-lane-scroll")) return;
      }
      event.preventDefault();
      const factor =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? node.clientWidth
            : 1;
      node.scrollLeft += event.deltaY * factor;
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      boardRef.current = null;
      node.removeEventListener("wheel", onWheel);
    };
  };

  const placed =
    overrides.size > 0
      ? items.map((item) => {
          const override = overrides.get(item.id);
          return override ? { ...item, ...override } : item;
        })
      : items;

  // Retire settled overrides during render — React's supported "adjust state
  // while rendering" path, so no frame paints with a stale override and this
  // needs no effect (banned in this codebase).
  if (overrides.size > 0 && !activeId) {
    const settled = [...overrides].filter(([id, placement]) => {
      const server = items.find((item) => item.id === id);
      return (
        server?.status === placement.status &&
        server.sortOrder === placement.sortOrder
      );
    });
    if (settled.length > 0) {
      setOverrides((prev) => {
        const next = new Map(prev);
        for (const [id] of settled) next.delete(id);
        return next;
      });
    }
  }

  // Animates lane changes that land without a drag (agent auto-move, the bulk
  // "Move to" action) — disabled while `activeId` is set so it stays out of
  // dnd-kit's own motion during an actual drag.
  useFlipLanes(
    boardRef,
    placed.map((item) => `${item.id}:${item.status}`).join(","),
    activeId === null,
    visible,
  );

  const laneItems = (status: string) =>
    placed.filter((item) => item.status === status).sort(bySortOrder);

  /** Shown-again lanes persist per person, so pulling one onto the board
   *  survives a reload. */
  const {
    lanes: boardLanes,
    hidden: hiddenLanes,
    hideable: hideableLanes,
    unplaced: unplacedLanes,
  } = laneVisibility({
    columns,
    deliveryEnabled,
    shownLanes: preferences.shownTaskBoardLanes,
    occupied: placed.map((item) => item.status),
  });
  const setLaneShown = (status: string, shown: boolean) =>
    setPreferences((prev) => ({
      ...prev,
      shownTaskBoardLanes: shown
        ? [...prev.shownTaskBoardLanes, status]
        : prev.shownTaskBoardLanes.filter((s) => s !== status),
    }));

  /** The columns a drag may land in — the board's own, never an off-board
   *  lane: a card can leave one, never be filed into one. */
  const columnKeys = new Set(columns.map((column) => column.key));

  /** Resolved against `placed` rather than dnd-kit's `over.data`, which is a
   *  ref and can't be read during render. */
  const laneOf = (overId: string | number | undefined) =>
    dropLane({
      overId,
      columnKeys,
      statusOf: (cardId) => placed.find((item) => item.id === cardId)?.status,
    });

  // A card inside a multi-selection drags the whole selection, grabbed card
  // first so it leads the run and the others follow in order.
  const groupOf = (id: string) =>
    selectedIds.has(id) && selectedIds.size > 1
      ? [id, ...Array.from(selectedIds).filter((other) => other !== id)]
      : [id];

  const place = (ids: string[], status: string, slot: number) => {
    const orders = runSortOrders(slot, ids.length);
    setOverrides((prev) => {
      const next = new Map(prev);
      ids.forEach((id, i) => next.set(id, { status, sortOrder: orders[i]! }));
      return next;
    });
  };

  const sensors = useSensors(
    // Distance threshold so a plain click (open the task) and a shift-click
    // (toggle selection) still work — the drag only engages once the pointer
    // actually travels.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragOver = (event: DragOverEvent) => {
    const id = String(event.active.id);
    const lane = laneOf(event.over?.id);
    const current = placed.find((item) => item.id === id);
    if (!lane || !current || current.status === lane) return;
    // Crossed into a different lane: preview the group there so the gap opens
    // under the cursor. Reordering *within* a lane needs no override — the
    // sortable strategy already shifts the neighbours.
    const ids = groupOf(id);
    const overId = String(event.over?.id ?? "");
    const target = laneItems(lane).filter((item) => !ids.includes(item.id));
    place(
      ids,
      lane,
      insertSortOrder(
        target,
        overId.startsWith(LANE_DROPPABLE_PREFIX) ? null : overId,
        id,
      ),
    );
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const id = String(event.active.id);
    setActiveId(null);
    const lane =
      laneOf(event.over?.id) ?? placed.find((item) => item.id === id)?.status;
    if (!lane) {
      setOverrides(new Map());
      return;
    }
    const ids = groupOf(id);
    // `placed` already shows the arrangement the user is looking at (a
    // cross-lane hover was applied in handleDragOver), so the landing slot is
    // just the sortable reorder within `lane`.
    const laneNow = laneItems(lane);
    const overId = String(event.over?.id ?? "");
    const from = laneNow.findIndex((item) => item.id === id);
    const to = overId.startsWith(LANE_DROPPABLE_PREFIX)
      ? laneNow.length - 1
      : laneNow.findIndex((item) => item.id === overId);
    const reordered =
      from === -1 || to === -1 ? laneNow : arrayMove(laneNow, from, to);

    // Dropped back exactly where it started — skip the write entirely.
    const serverOrder = items
      .filter((item) => item.status === lane)
      .sort(bySortOrder)
      .map((item) => item.id)
      .join();
    if (serverOrder === reordered.map((item) => item.id).join()) {
      setOverrides(new Map());
      return;
    }

    // The first non-group card after the landing point defines the slot; group
    // members are excluded so they can't skew their own midpoint.
    const after = reordered
      .slice(reordered.findIndex((item) => item.id === id) + 1)
      .find((item) => !ids.includes(item.id));
    const slot = insertSortOrder(
      laneNow.filter((item) => !ids.includes(item.id)),
      after?.id ?? null,
      id,
    );
    place(ids, lane, slot);
    setLandedIds(ids);
    onMove(ids, lane, slot);
  };

  const activeItem = activeId
    ? placed.find((item) => item.id === activeId)
    : null;
  const activeGroup = activeId ? groupOf(activeId) : [];

  return (
    <DndContext
      sensors={sensors}
      // Corners beat centers across lanes: a tall card's center can sit outside
      // the column the pointer is actually over.
      collisionDetection={closestCorners}
      onDragStart={(event: DragStartEvent) => {
        setActiveId(String(event.active.id));
        setLandedIds([]);
      }}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={() => {
        setActiveId(null);
        setOverrides(new Map());
      }}
    >
      {/* Scroll container spans the full panel width so the wheel works even
          when the pointer is in the empty margins on wide monitors. */}
      <div ref={attachBoard} className="min-h-0 flex-1 overflow-x-auto">
        {/* Padding lives on the capped row (not the scroll container) so its
            left edge matches the header's max-w + px exactly. Bottom breathing
            room is handled per-lane by each column's own scrollable div — a pb
            here would eat into this row's h-full and cut every column short,
            since it no longer wraps a single page-level scroll. */}
        <div className="mx-auto flex h-full w-full max-w-[1680px] gap-3 px-4 pt-6 sm:px-8">
          {boardLanes.map((status) => (
            <Lane
              key={status}
              status={status}
              columns={columns}
              offBoard={unplacedLanes.includes(status)}
              items={laneItems(status)}
              members={members}
              memberByUserId={memberByUserId}
              selectedIds={selectedIds}
              // Highlight the lane the drag currently sits in. Derived from the
              // preview rather than `useDroppable`'s `isOver`, which goes false
              // whenever a card (not the lane) is the drop target and would
              // strobe the background.
              isTarget={activeItem?.status === status}
              hiddenIds={activeGroup}
              landedIds={landedIds}
              onToggleSelect={onToggleSelect}
              onSelectAllInLane={onSelectAllInLane}
              onOpen={onOpen}
              onCreate={onCreate}
              onAutoFix={onAutoFix}
              onRerun={onRerun}
              onAssign={onAssign}
              onPriorityChange={onPriorityChange}
              onTypeChange={onTypeChange}
              onDueDateChange={onDueDateChange}
              onHide={
                hideableLanes.includes(status)
                  ? () => setLaneShown(status, false)
                  : undefined
              }
            />
          ))}
          {hiddenLanes.length > 0 && (
            <HiddenLanes
              statuses={hiddenLanes}
              columns={columns}
              countOf={(status) => laneItems(status).length}
              onShow={(status) => setLaneShown(status, true)}
            />
          )}
        </div>
      </div>
      {/* Portal to body so the overlay's `position: fixed` resolves against the
          viewport rather than the workspace PanelCard's transformed containing
          block (which would offset the card from the cursor). */}
      {createPortal(
        // No drop animation: because the lane opens a live gap under the
        // cursor, the card's final slot IS where you released it — measured at
        // ~10px of travel on a normal drop, so any flight here is invisible
        // work. The landing is animated on the card itself instead (see
        // `landed` / `animate-card-land`), which reads regardless of distance.
        <DragOverlay dropAnimation={null}>
          {activeItem && (
            // Matches the lane's card width (w-[300px] column minus the
            // scroll container's px-1) — outside the lane, nothing else
            // constrains the card's width, so it would shrink to its content.
            <div className="relative w-[292px] cursor-grabbing">
              <TaskCard
                item={activeItem}
                assignee={
                  activeItem.assigneeId
                    ? memberByUserId.get(activeItem.assigneeId)
                    : undefined
                }
                assignedBy={
                  activeItem.assignedBy
                    ? memberByUserId.get(activeItem.assignedBy)
                    : undefined
                }
                selected={selectedIds.has(activeItem.id)}
                onOpen={() => {}}
                className="w-full shadow-lg"
              />
              {activeGroup.length > 1 && (
                <span className="absolute -top-2 -right-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-foreground px-1.5 text-[11px] font-semibold text-background">
                  {activeGroup.length}
                </span>
              )}
            </div>
          )}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}

/** The board's tail: lanes that don't get a column until asked for. `<details>`
 *  gives the collapse (closed by default) without any state of its own. */
function HiddenLanes({
  statuses,
  columns,
  countOf,
  onShow,
}: {
  statuses: string[];
  columns: readonly BoardColumn[];
  countOf: (status: string) => number;
  onShow: (status: string) => void;
}) {
  const t = useT();
  return (
    <details className="group h-full w-[300px] shrink-0 py-1">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight
          size={14}
          className="shrink-0 transition-transform group-open:rotate-90"
        />
        {t("taskBoard.taskBoard.hiddenColumns")}
      </summary>
      <div className="flex flex-col gap-2 px-1 pt-1">
        {statuses.map((status) => {
          const { label, visual } = laneHeader(status, t, columns);
          const LaneIcon = visual.icon;
          return (
            <div
              key={status}
              data-hidden-lane={status}
              className="flex items-center gap-2 rounded-xl bg-background px-3 py-2.5 card-shadow"
            >
              <LaneIcon
                size={15}
                className={cn("shrink-0", visual.iconClassName)}
              />
              <span className="text-sm font-medium text-foreground">
                {label}
              </span>
              <span className="ml-auto text-[11px] font-medium text-muted-foreground">
                {countOf(status)}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t("taskBoard.taskBoard.laneMenuAriaLabel", {
                      lane: label,
                    })}
                    className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <DotsHorizontal size={15} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => onShow(status)}>
                    {t("taskBoard.taskBoard.showColumn")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        })}
      </div>
    </details>
  );
}

function Lane({
  status,
  columns,
  offBoard,
  items,
  members,
  memberByUserId,
  selectedIds,
  isTarget,
  hiddenIds,
  landedIds,
  onToggleSelect,
  onSelectAllInLane,
  onOpen,
  onCreate,
  onAutoFix,
  onRerun,
  onAssign,
  onPriorityChange,
  onTypeChange,
  onDueDateChange,
  onHide,
}: {
  status: string;
  /** The board's own columns — what gives this lane its name. */
  columns: readonly BoardColumn[];
  /** No column on this board accounts for this status; the lane exists only
   *  because cards are sitting in it. */
  offBoard: boolean;
  items: TaskBoardItem[];
  members: Member[];
  memberByUserId: Map<string, Member>;
  selectedIds: Set<string>;
  isTarget: boolean;
  /** Cards riding in the DragOverlay — held in the layout as gaps. */
  hiddenIds: string[];
  /** Cards that just landed from a drop — they play the settle animation. */
  landedIds: string[];
  onToggleSelect: (id: string) => void;
  onSelectAllInLane: (status: string) => void;
  onOpen: (item: TaskBoardItem) => void;
  onCreate: (status: string) => void;
  onAutoFix?: (item: TaskBoardItem) => void;
  onRerun?: (item: TaskBoardItem) => void;
  onAssign?: (id: string, userId: string | null) => void;
  onPriorityChange?: (id: string, priority: TaskBoardItemPriority) => void;
  onTypeChange?: (id: string, type: TaskBoardItemType) => void;
  onDueDateChange?: (id: string, iso: string) => void;
  /** Present only for a hidden-by-default lane, which can be put back away. */
  onHide?: () => void;
}) {
  const t = useT();
  const { label, visual } = laneHeader(status, t, columns);
  const LaneIcon = visual.icon;
  // The lane's own droppable covers the empty space below the last card, so an
  // empty lane (and the area past the end of a short one) still takes a drop.
  const { setNodeRef } = useDroppable({
    id: `${LANE_DROPPABLE_PREFIX}${status}`,
  });

  return (
    <div
      // Stable hook for e2e drag specs — lane columns are otherwise only
      // identifiable by their localized label or utility classes.
      data-lane={status}
      className={cn(
        "flex h-full w-[300px] shrink-0 flex-col rounded-xl py-1 transition-colors",
        isTarget && "bg-muted/50",
      )}
    >
      {/* Sticky so the column header stays visible while the cards scroll
          vertically under it — needs an opaque bg for that to hide scrolled-
          under cards, so it tracks the lane's own highlight color (solid,
          since bg-muted/50 would let cards show through) rather than a fixed
          one that'd seam against it while a drag is over the lane. */}
      <div
        className={cn(
          "sticky top-0 z-10 flex items-center gap-2 px-2 py-1.5 transition-colors",
          isTarget ? "bg-muted" : "bg-background",
        )}
      >
        {/* Static in the header — unlike the card's own status icon, this
            one isn't tied to a specific task, so spinning it reads as the
            whole lane being "busy" rather than as in-progress work. */}
        <LaneIcon
          size={15}
          className={cn(
            "shrink-0",
            visual.iconClassName.replace(/\banimate-\S+\b/g, "").trim(),
          )}
        />
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="rounded-md bg-muted px-1.5 text-[11px] font-medium text-muted-foreground">
          {items.length}
        </span>
        {offBoard && (
          <span
            className="rounded-md border border-border px-1.5 text-[11px] font-medium text-muted-foreground"
            title={t("taskBoard.taskBoard.offBoardLaneTooltip", { status })}
          >
            {t("taskBoard.taskBoard.offBoardLaneBadge")}
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t("taskBoard.taskBoard.laneMenuAriaLabel", {
                lane: label,
              })}
              className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <DotsHorizontal size={15} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onSelectAllInLane(status)}>
              {t("taskBoard.taskBoard.selectAllInLane")}
            </DropdownMenuItem>
            {onHide && (
              <DropdownMenuItem onClick={onHide}>
                {t("taskBoard.taskBoard.hideColumn")}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {/* No "new task here" off board: the lane is not a column, so a card
            created in it would be stranded the moment it existed. */}
        {!offBoard && (
          <button
            type="button"
            aria-label={t("taskBoard.taskBoard.newTaskInLaneAriaLabel", {
              lane: label,
            })}
            title={t("taskBoard.taskBoard.newTaskInLaneTitle", { lane: label })}
            onClick={() => onCreate(status)}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Plus size={15} />
          </button>
        )}
      </div>
      {/* px-1 so each card's shadow has room inside the scrollport — an
          overflow-y container clips the x-axis too, which would clip a FLIP-
          animated card mid-flight between lanes (see `use-flip-lanes`,
          keyed off `data-lane-scroll`). */}
      <div
        ref={setNodeRef}
        data-lane-scroll={status}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-1 pt-1 pb-16 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1"
      >
        <SortableContext
          items={items.map((item) => item.id)}
          strategy={verticalListSortingStrategy}
        >
          {items.map((item) => (
            <SortableTaskCard
              key={item.id}
              item={item}
              assignee={
                item.assigneeId
                  ? memberByUserId.get(item.assigneeId)
                  : undefined
              }
              assignedBy={
                item.assignedBy
                  ? memberByUserId.get(item.assignedBy)
                  : undefined
              }
              members={members}
              selected={selectedIds.has(item.id)}
              hidden={hiddenIds.includes(item.id)}
              landed={landedIds.includes(item.id)}
              onToggleSelect={() => onToggleSelect(item.id)}
              onOpen={() => onOpen(item)}
              onAutoFix={onAutoFix ? () => onAutoFix(item) : undefined}
              onRerun={onRerun ? () => onRerun(item) : undefined}
              onAssign={
                onAssign ? (userId) => onAssign(item.id, userId) : undefined
              }
              onPriorityChange={
                onPriorityChange
                  ? (priority) => onPriorityChange(item.id, priority)
                  : undefined
              }
              onTypeChange={
                onTypeChange ? (type) => onTypeChange(item.id, type) : undefined
              }
              onDueDateChange={
                onDueDateChange
                  ? (iso) => onDueDateChange(item.id, iso)
                  : undefined
              }
            />
          ))}
        </SortableContext>
      </div>
    </div>
  );
}

/** A card in a lane. `useSortable` supplies the transform that slides it aside
 *  to open a gap, and the transition that animates it into place. */
function SortableTaskCard({
  item,
  hidden,
  landed,
  ...props
}: {
  item: TaskBoardItem;
  assignee?: Member;
  assignedBy?: Member;
  members?: Member[];
  selected?: boolean;
  hidden: boolean;
  landed: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
  onAutoFix?: () => void;
  onRerun?: () => void;
  onAssign?: (userId: string | null) => void;
  onPriorityChange?: (priority: TaskBoardItemPriority) => void;
  onTypeChange?: (type: TaskBoardItemType) => void;
  onDueDateChange?: (iso: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });

  return (
    // FLIP (see `use-flip-lanes`) owns this wrapper's `transform`/`transition`
    // imperatively, outside React — it needs an element React never re-styles
    // itself, since dnd-kit's own transform/transition below is applied to the
    // card and gets reset on every render, which would cancel FLIP's animation
    // as soon as any unrelated re-render landed mid-flight.
    <div className="flex" data-flip-id={item.id} data-flip-lane={item.status}>
      <TaskCard
        {...props}
        item={item}
        dragRef={setNodeRef}
        bindings={{ attributes, listeners }}
        className={cn("w-full", landed && "animate-card-land")}
        style={{
          transform: CSS.Translate.toString(transform),
          transition,
          // The dragged card (and the rest of its group, riding along in the
          // overlay) leaves a gap rather than a ghost.
          opacity: isDragging || hidden ? 0 : undefined,
        }}
      />
    </div>
  );
}

function TaskCard({
  item,
  assignee,
  assignedBy,
  members,
  selected,
  className,
  dragRef,
  bindings,
  style,
  onToggleSelect,
  onOpen,
  onAutoFix,
  onRerun,
  onAssign,
  onPriorityChange,
  onTypeChange,
  onDueDateChange,
}: {
  item: TaskBoardItem;
  assignee?: Member;
  assignedBy?: Member;
  members?: Member[];
  selected?: boolean;
  className?: string;
  /** Supplied by `SortableTaskCard`; absent for the DragOverlay clone. */
  dragRef?: (node: HTMLElement | null) => void;
  bindings?: SortableBindings;
  style?: CSSProperties;
  onToggleSelect?: () => void;
  onOpen: () => void;
  onAutoFix?: () => void;
  onRerun?: () => void;
  onAssign?: (userId: string | null) => void;
  onPriorityChange?: (priority: TaskBoardItemPriority) => void;
  onTypeChange?: (type: TaskBoardItemType) => void;
  onDueDateChange?: (iso: string) => void;
}) {
  const t = useT();
  const sprint = useCardSprint(item);
  const checks = useCardChecks(item);
  const runState = agentRunState(item);
  // A state of the card, not a label on it — hence the colour, not a chip.
  const attentionLabel = cardNeedsAttention(item)
    ? t("taskBoard.taskBoard.blockedBadgeTitle")
    : null;

  const showAutoFix =
    onAutoFix &&
    (item.status === "triage" || item.status === "todo") &&
    item.assigneeId !== SUPER_AGENT_ASSIGNEE_ID;

  // The counterpart for a card the Super Agent already owns. Auto-fix hides
  // itself once assigned (it delegates, and it's already delegated), which left
  // such a card with NO way to start a run — and re-picking the same assignee
  // is a no-op, so a stalled card was unrecoverable from the board.
  //
  // Deliberately NOT gated on "no run in flight": the cards that need this most
  // are the ones whose thread reads `in_progress` forever because its run never
  // started, and hiding the button behind a liveness check is exactly what made
  // them unrecoverable. The confirm dialog carries the warning instead.
  const showRerun =
    onRerun &&
    !showAutoFix &&
    item.assigneeId === SUPER_AGENT_ASSIGNEE_ID &&
    item.status !== "done";

  return (
    <button
      type="button"
      ref={dragRef}
      style={style}
      {...bindings?.attributes}
      {...bindings?.listeners}
      onClick={(e) => {
        if (e.shiftKey && onToggleSelect) onToggleSelect();
        else onOpen();
      }}
      className={cn(
        "group relative flex shrink-0 cursor-grab flex-col gap-3 rounded-xl px-3.5 pt-3.5 pb-2.5 text-left card-shadow active:cursor-grabbing",
        attentionLabel
          ? "bg-warning/10 hover:bg-warning/15"
          : "bg-card hover:bg-accent/60",
        // A dead run outranks a question: both want a person, but only one is already broken.
        runState === "failed"
          ? "card-ring-destructive"
          : attentionLabel && "card-ring-warning",
        selected && "bg-accent",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        {/* 14px: one step over the design system's `text-sm`, which is 13 here, not Tailwind's 14. */}
        <span className="min-w-0 flex-1 text-[14px] font-[450] leading-snug text-foreground line-clamp-2">
          {item.title}
        </span>
        {attentionLabel && <span className="sr-only">{attentionLabel}</span>}
        {runState && <AgentRunIndicator state={runState} />}
      </div>

      {(sprint != null || item.tags.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          {sprint != null && <SprintPill sprint={sprint} />}
          {item.tags.slice(0, CARD_TAG_LIMIT).map((tag) => (
            <TagPill key={tag.id} tag={tag} />
          ))}
          {item.tags.length > CARD_TAG_LIMIT && (
            <span className={PILL}>+{item.tags.length - CARD_TAG_LIMIT}</span>
          )}
        </div>
      )}

      <CardFooter
        item={item}
        checks={checks}
        assignee={assignee}
        assignedBy={assignedBy}
        members={members}
        onAssign={onAssign}
        onPriorityChange={onPriorityChange}
        onTypeChange={onTypeChange}
        onDueDateChange={onDueDateChange}
        action={
          showAutoFix
            ? {
                icon: Lightning01,
                label: t("taskBoard.taskBoard.autoFix"),
                onClick: onAutoFix,
              }
            : showRerun
              ? {
                  icon: RefreshCw01,
                  label: t("taskBoard.taskBoard.rerun"),
                  onClick: onRerun,
                }
              : undefined
        }
      />
    </button>
  );
}

function ListRow({
  item,
  assignee,
  assignedBy,
  onOpen,
}: {
  item: TaskBoardItem;
  assignee?: Member;
  assignedBy?: Member;
  onOpen: () => void;
}) {
  const StatusIcon = laneVisual(item.status).icon;
  const sprint = useCardSprint(item);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex items-center gap-3 rounded-xl bg-card px-4 py-3 text-left card-shadow transition-colors hover:bg-accent/60"
    >
      <StatusIcon
        size={16}
        className={cn("shrink-0", statusIconClassName(item))}
      />
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        {item.title}
      </span>
      {isTaskBlocked(item) && <BlockedBadge />}
      {isTaskHandedToHuman(item) && <HandedToHumanBadge />}
      {item.priority !== "none" && (
        <span className="hidden sm:inline-flex">
          <PriorityPill priority={item.priority} />
        </span>
      )}
      {item.dueDate && (
        <span className="hidden sm:inline-flex">
          <DueDatePill iso={item.dueDate} />
        </span>
      )}
      {sprint != null && (
        <span className="hidden sm:inline-flex">
          <SprintPill sprint={sprint} />
        </span>
      )}
      {item.tags.length > 0 && (
        <span className="hidden items-center gap-1.5 sm:inline-flex">
          {item.tags.slice(0, 2).map((tag) => (
            <TagPill key={tag.id} tag={tag} />
          ))}
          {item.tags.length > 2 && (
            <span className={PILL}>+{item.tags.length - 2}</span>
          )}
        </span>
      )}
      <AssigneeDisplay
        item={item}
        assignee={assignee}
        assignedBy={assignedBy}
      />
      <span className="hidden shrink-0 text-[11px] text-muted-foreground/70 sm:inline">
        {formatTimeAgo(new Date(item.createdAt))}
      </span>
    </button>
  );
}
