import { Page } from "@/components/page";
import { Panel } from "@/components/panel";
/**
 * Task board — the org's own board of tasks (title,
 * description, status, priority, assignee), independent of chat threads.
 * Rendered as a main-panel overlay tab; there is no standalone route.
 */

import { useRef, useState } from "react";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
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
import {
  TaskBoardAdminBanner,
  TaskBoardAdminControls,
  TaskBoardAnalyticsButton,
} from "./admin-controls";
import { BoardOrgProvider } from "./board-org";
import { authClient } from "@/lib/auth-client";
import { AgenticSetupButton } from "./agentic-setup";
import { ColumnRulesSheet, useEntryAutomations } from "./column-rules";
import { useTaskBoardRulesLive } from "@/hooks/use-task-board-prompts";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Button } from "@decocms/ui/components/button.tsx";
import { SearchToggle } from "@decocms/ui/components/search-toggle.tsx";
import { useT, type TranslationKey } from "@/i18n/use-t.ts";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import {
  AlertTriangle,
  Calendar,
  Check,
  AlertOctagon,
  CheckCircle,
  Clock,
  ChevronRight,
  DotsHorizontal,
  HelpCircle,
  Inbox01,
  Lightning01,
  LinkExternal01,
  Plus,
  RefreshCw01,
  Stars02,
  User01,
  UserPlus01,
  X,
  Zap,
} from "@untitledui/icons";
import { Maximize2, Minimize2 } from "lucide-react";
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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@decocms/ui/components/context-menu.tsx";
import { SuperAgentIcon } from "@/components/super-agent-icon";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { runningAgents } from "@/components/org-home/daily-pulse";
import { ReviewerIcon } from "@/components/reviewer-icon";
import { getWellKnownDecopilotVirtualMCP, useProjectContext } from "@/sdk";

import { RepositoryImportPicker } from "@/components/repository-import-picker";
import { useMembers } from "@/hooks/use-members";
import {
  useTaskBoardItemActions,
  useTaskBoardItems,
} from "@/hooks/use-task-board-items";
import {
  useTaskBoardSprints,
  useTaskBoardSprintsLive,
} from "@/hooks/use-task-board-sprints";
import { currentSprintId } from "@decocms/shared/sprints";
import { SprintSwitcher } from "./sprint-controls";
import { sprintLabel } from "./sprint-label";
import { formatTimeAgo } from "@/lib/format-time";
import {
  agentRunState,
  cardNeedsAttention,
  isCriticalTask,
  isLiveAttempt,
  TASK_TYPE_CONFIG,
  type TaskBoardItemType,
  daysSince,
  dueDateUrgency,
  insertSortOrder,
  isTaskBlocked,
  isTaskHandedToHuman,
  HIDDEN_STATUSES,
  boardGridColumns,
  isLaneShown,
  laneVisibility,
  nextTagColor,
  PRIORITIES,
  PRIORITY_CONFIG,
  runSortOrders,
  boardCollisions,
  dropLane,
  LANE_DROPPABLE_PREFIX,
  CRITICAL_DROPPABLE_PREFIX,
  dropSwimlane,
  hasCriticalWell,
  swimlanePriority,
  laneHeader,
  laneVisual,
  statusIconClassName,
  SUPER_AGENT_ASSIGNEE_ID,
  tagDotColor,
  TASK_TYPES,
  type TaskBoardItem,
  type TaskBoardItemPriority,
  type TaskBoardItemStatus,
  type TaskBoardItemTag,
  type Member,
  type OrgTag,
} from "./config";
import {
  EpicBoardProvider,
  EpicPill,
  EpicProgressPill,
  EpicsView,
  SubtaskPill,
  laneCards,
  useEpicBoard,
} from "./epics";
import { useCreateTag, useDeleteTag, useTags } from "@/hooks/use-tags";
import { useReviewerEnabled } from "@/hooks/use-organization-settings";
import { usePreferences, useProjectFirstNav } from "@/hooks/use-preferences";
import {
  TaskBoardItemDetail,
  TaskBoardItemDialog,
  toEndOfDayIso,
} from "./task-dialog";
import { AssigneePickerContent } from "./assignee-picker";
import { TagPickerContent } from "./tag-picker";
import { useRepositories } from "@/hooks/use-git-providers";
import { SubscriptionPaywallDialog } from "./subscription-paywall-dialog";
import { RerunDialog } from "./rerun-dialog";
import { subscriptionErrorKind } from "@/components/task-board/is-subscription-error";
import {
  CANONICAL_COLUMN_KEYS,
  DEFAULT_TASK_TYPE,
  isReportsTask,
  type ReviewerKind,
} from "@decocms/shared/task-board";
import {
  type ChecksSummary,
  checksSummary,
  enabledReviewers,
} from "./review-status";
import { taskKey } from "@decocms/shared/task-key";
import { useFlipLanes } from "./use-flip-lanes";
import { summarizeTaskCost } from "./task-cost";
import { Calendar as DayPickerCalendar } from "@decocms/ui/components/calendar.tsx";
import { buildTaskChatContext } from "./build-task-chat-context";
import { track } from "@/lib/posthog-client";
import { useStudioTools } from "@/lib/studio-tools";
import {
  EMPTY_FILTERS,
  resolveSprintFilter,
  taskMatchesFilters,
  type TaskFilters,
} from "./task-filters-core";
import {
  AppliedFiltersBar,
  BoardSettingsButton,
  ColumnsButton,
  GroupByButton,
  SortByButton,
  TaskFilterButton,
} from "./view-controls";
import { sortListItems } from "./list-sort";
import {
  groupLevels,
  groupListItems,
  NO_TAG_GROUP,
  isGroupOpen,
  toggleGroupOpen,
  type ListGroup,
} from "./list-groups";
import { UNASSIGNED_FILTER } from "./task-filters-core";
import {
  enabledLayout,
  savedAssigneeDefault,
  useBoardSearch,
  visibleSelection,
} from "./filters-search";
import { feedEventKind, groupFeedByDay, type FeedEventKind } from "./feed";
import { useProjectIndex } from "@/hooks/use-project-index";
import { useProjectScope } from "@/hooks/use-project-scope";
import { projectRepo } from "@/lib/repository-binding";
import { scopedBoardItems } from "./board-scope";
import {
  entryForFilter,
  entryForTask,
  filterAfterCreate,
  stampFor,
  type AttributableTask,
  NO_PROJECT_FILTER,
  stampableEntries,
  type ProjectIndex,
  type ProjectIndexEntry,
} from "@/lib/project-index";
import { ProjectEntryIcon, ProjectEntryRow } from "@/components/project-entry";
import { usePanelActions } from "@/layouts/shell-layout";
import {
  Navigate,
  useNavigate,
  useParams,
  useRouter,
} from "@tanstack/react-router";
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
void import("../../routes/thread-session/route.tsx").catch(() => {});

const DATE_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

/** Shared meta chip: an outlined pill, neutral border by default. */
const PILL =
  "inline-flex items-center gap-1 rounded-full border-[length:var(--border-hairline)] border-border px-2 py-0.5 text-xs font-medium text-muted-foreground";

/** A fact about a row said in plain text — glyph and word, no chrome. The
 *  bordered {@link PILL} is kept for a tag, whose colour IS its border. */
const META =
  "inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground";

/** An empty list-row property: revealed on row hover, focus, or an open menu,
 *  so a row of unset fields doesn't read as a row of holes. */
const HOVER_ONLY =
  "opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100";

/** A lane's own controls: revealed on hover, focus, or an open menu. */
/** Shown on lane hover, and on the lane a drag is over: the dragged card
 *  holds the pointer then, so the lane itself never reads as hovered. */
const LANE_ACTION =
  "flex size-6 shrink-0 items-center justify-center rounded-lg text-muted-foreground opacity-0 transition-[color,background-color,opacity] hover:bg-accent hover:text-foreground group-hover/lane:opacity-100 group-data-[drop-target]/lane:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100";

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

/** Tags a card or list row shows before collapsing the rest into `+N`; the
 *  full set is in the task dialog. */
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
  /** Null only on a list row, where the picker is how a date gets set. */
  iso: string | null;
  onChange?: (iso: string) => void;
}) {
  const t = useT();
  const urgency = iso ? dueDateUrgency(iso) : null;
  const content = (
    <>
      <Calendar className={cn(PROPERTY_GLYPH_CLASS, "shrink-0")} />
      {iso && (
        <span className="truncate">{DATE_FMT.format(new Date(iso))}</span>
      )}
    </>
  );
  // The footer item that gives way, so a full footer never overlaps.
  const tone = cn(
    "min-w-0 shrink items-center gap-1.5 text-xs font-medium tabular-nums text-muted-foreground/70",
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
          aria-label={iso ? undefined : t("taskBoard.taskBoard.dueDateButton")}
          title={iso ? undefined : t("taskBoard.taskBoard.dueDateButton")}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          // Matches the glyph buttons: the padding is hover surface only, so the row still spaces itself off the content.
          className={cn(
            "-mx-1.5 h-auto px-1.5 py-1 font-medium",
            tone,
            !iso && HOVER_ONLY,
          )}
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
          selected={iso ? new Date(iso) : undefined}
          defaultMonth={iso ? new Date(iso) : undefined}
          onSelect={(date) => date && onChange(toEndOfDayIso(date))}
          initialFocus
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The card's one run action, floating in the title's top-right corner.
 *
 * Nothing else on the card can host it. The footer can't: every glyph there
 * (type, due date, priority, assignee) is a control you reach by hovering, so
 * covering one on hover removes the very affordance the hover grants. A row of
 * its own costs every actionable card that height, forever, for a button you
 * only want while pointing at the card.
 *
 * What made the corner unreadable was the hard edge, not the overlap — the
 * title ran straight into the button mid-word. So the title fades out under it
 * (`fade-text-end`) and reads as trailing off instead.
 */
function CardAction({
  action,
}: {
  action: { icon: typeof RefreshCw01; label: string; onClick: () => void };
}) {
  return (
    <Button
      variant="outline"
      size="xs"
      onClick={(e) => {
        e.stopPropagation();
        action.onClick();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      // The fade has to end where this button starts, and how wide it is depends on the label — i.e. on the language.
      ref={(node) =>
        node?.parentElement?.style.setProperty(
          "--fade-text-end",
          `${node.offsetWidth}px`,
        )
      }
      className="absolute -top-0.5 right-0 gap-1.5 font-medium pointer-events-none opacity-0 transition-opacity focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
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
  leading,
  trailing,
  onAssign,
  onPriorityChange,
  onTypeChange,
  onDueDateChange,
}: {
  item: TaskBoardItem;
  checks: { summary: ChecksSummary; enabled: ReviewerKind[] } | null;
  assignee?: Member;
  assignedBy?: Member;
  members?: Member[];
  /** Facts a feed post cannot get from its surroundings — project, lane, cost.
   *  In the left group so the footer keeps one baseline on both surfaces. */
  leading?: ReactNode;
  /** The right edge, after the assignee — a feed post's timestamp lands here
   *  rather than in its own row. */
  trailing?: ReactNode;
  onAssign?: (userId: string | null) => void;
  onPriorityChange?: (priority: TaskBoardItemPriority) => void;
  onTypeChange?: (type: TaskBoardItemType) => void;
  onDueDateChange?: (iso: string) => void;
}) {
  const { org } = useProjectContext();
  const key = taskKey(org.slug, item.keySeq);
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
        {leading}
      </span>
      <span className="flex shrink-0 items-center gap-2">
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
        {trailing}
      </span>
    </div>
  );
}

/** How long the task has sat in its current status. */
function StatusAgePill({
  status: statusKey,
  since,
}: {
  status: string;
  since: string;
}) {
  const t = useT();
  // Day granularity: the time the row mounted is close enough.
  const [now] = useState(() => Date.now());
  const days = daysSince(since, now);
  const status = laneHeader(statusKey, t).label;
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>
        <span className={PILL}>
          <Clock size={FOOTER_GLYPH} />
          {days === 0
            ? t("taskBoard.taskBoard.statusAgeToday")
            : t("taskBoard.taskBoard.statusAgeDays", { count: days })}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        {days === 0
          ? t("taskBoard.taskBoard.statusAgeTodayHint", { status })
          : t("taskBoard.taskBoard.statusAgeDaysHint", {
              status,
              count: days,
            })}
      </TooltipContent>
    </Tooltip>
  );
}

/** The sprint a card is planned into; nothing for a card in the backlog. */
function SprintPill({ sprintId }: { sprintId: string | null }) {
  const sprint = useTaskBoardSprints().find((s) => s.id === sprintId);
  if (!sprint) return null;
  return (
    <span className={cn(PILL, "text-foreground")}>
      <Zap size={10} className="shrink-0 text-muted-foreground" />
      {sprint.name}
    </span>
  );
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
  // This used its own LoaderCircle because the spinner of the day was eight
  // evenly-spaced spokes: rotating it lands on an identical image every 45°,
  // so `animate-spin` read as a still frame. The shared `Spinner` is an arc
  // now — asymmetric, so it looks like it is turning — which is the whole
  // reason this call site can stop being special.
  return (
    <span className="mt-px flex shrink-0 items-center">
      <GlyphTooltip label={label}>
        {running ? (
          <Spinner className="size-3.5 text-primary" label={label} />
        ) : (
          <AlertTriangle
            size={14}
            className="shrink-0 text-destructive"
            aria-label={label}
          />
        )}
      </GlyphTooltip>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * The card's checks indicator, or null when there is nothing to say: this org
 * runs no reviewers, or the task has not reached review yet (a Backlog card
 * with `0/1` would be reporting a failure that hasn't had a chance to happen).
 *
 * "Reached review" is the open cycle as well as the In Review lane: a cycle
 * opened by the previous release can sit on an In Progress card, and the lane
 * alone would hide the checks for the whole time they are being decided.
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
  const collapseWhenHidden = useProjectFirstNav();
  const t = useT();
  const [open, setOpen] = useState(false);

  let current: ReactNode = null;
  if (item.assigneeId === SUPER_AGENT_ASSIGNEE_ID) {
    const title = assignedBy?.user?.name
      ? t("taskBoard.taskBoard.assignedToSuperAgentBy", {
          name: assignedBy.user.name,
        })
      : t("taskBoard.taskBoard.assignedToSuperAgent");
    if (!showDelegation) {
      current = assignedBy ? (
        <Avatar
          url={assignedBy.user?.image ?? undefined}
          fallback={assignedBy.user?.name ?? "?"}
          shape="circle"
          size="xs"
          title={title}
        />
      ) : null;
    } else {
      current = (
        <span className="inline-flex items-center" title={title}>
          {assignedBy && (
            <Avatar
              url={assignedBy.user?.image ?? undefined}
              fallback={assignedBy.user?.name ?? "?"}
              shape="circle"
              size="xs"
              className="-mr-2 ring-2 ring-background"
            />
          )}
          <SuperAgentIcon size={20} className="ring-2 ring-background" />
        </span>
      );
    }
  } else if (assignee) {
    current = (
      <Avatar
        url={assignee.user?.image ?? undefined}
        fallback={assignee.user?.name ?? "?"}
        shape="circle"
        size="xs"
      />
    );
  }
  if (!onAssign || !members?.length) return current;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {current ? (
          <button
            type="button"
            title={t("taskBoard.taskBoard.assignButton")}
            aria-label={t("taskBoard.taskBoard.assignButton")}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(true);
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className="flex shrink-0 items-center rounded-full transition-opacity hover:opacity-80"
          >
            {current}
          </button>
        ) : (
          <button
            type="button"
            title={t("taskBoard.taskBoard.assignButton")}
            aria-label={t("taskBoard.taskBoard.assignButton")}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(true);
            }}
            // Hover-only: a dashed circle on every unassigned card is a row of holes.
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed border-muted-foreground/40 text-muted-foreground/40 opacity-0 transition-[color,border-color,opacity] group-hover:opacity-100 hover:border-muted-foreground hover:text-muted-foreground focus-visible:opacity-100 data-[state=open]:opacity-100",
              // Takes no room until shown, so the glyphs beside it sit flush right.
              collapseWhenHidden &&
                "-ml-2 w-0 scale-75 overflow-hidden border-0 transition-[color,border-color,opacity,width,margin,scale] duration-150 ease-out group-hover:ml-0 group-hover:w-6 group-hover:scale-100 group-hover:border focus-visible:ml-0 focus-visible:w-6 focus-visible:scale-100 focus-visible:border data-[state=open]:ml-0 data-[state=open]:w-6 data-[state=open]:scale-100 data-[state=open]:border motion-reduce:transition-none",
            )}
          >
            <UserPlus01 size={13} />
          </button>
        )}
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

/** The board, pointed at whichever org `?boardOrg=` names (normally your own).
 *  The swap has to wrap the board rather than live inside it: every hook below
 *  reads the org off `ProjectContext`. */
export function TaskBoardPage() {
  return (
    <BoardOrgProvider>
      <TaskBoardBody />
    </BoardOrgProvider>
  );
}

function TaskBoardBody() {
  const t = useT();
  const { org, locator } = useProjectContext();
  const { items: orgItems, isLoading: itemsLoading } = useTaskBoardItems();
  /** A project's home IS this board — see `board-scope.ts` for why scope is a
   *  narrowing of the input rather than a value in the `?repo=` filter. */
  const {
    scopeId,
    project: scopedProject,
    projects: orgProjects,
  } = useProjectScope();
  const { items, isLoading } = scopedBoardItems({
    items: orgItems,
    scopeId,
    project: scopedProject,
    projects: orgProjects,
    isLoading: itemsLoading,
  });
  const { data: orgTags = [] } = useTags();
  const sprints = useTaskBoardSprints();
  useTaskBoardSprintsLive();
  const actions = useTaskBoardItemActions();
  const repositories = useRepositories();
  const usableRepos = (repositories.data ?? []).filter(
    (repository) => repository.usable,
  );
  const hasRepo = usableRepos.length > 0;
  const repos = usableRepos.map((repository) => repository.path);
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);
  // Returns true if the assignment was blocked (connect prompt opened) so the
  // caller stops before dispatching.
  const blockSuperAgentWithoutRepository = (
    assigneeId: string | null | undefined,
  ) => {
    if (assigneeId === SUPER_AGENT_ASSIGNEE_ID && !hasRepo) {
      setRepoPickerOpen(true);
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
    if (blockSuperAgentWithoutRepository(SUPER_AGENT_ASSIGNEE_ID)) {
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
  const { data: session } = authClient.useSession();
  const { data: membersData } = useMembers();
  const members = (membersData?.data?.members ?? []) as Member[];
  const memberByUserId = new Map(members.map((m) => [m.userId, m]));

  /** The feed is part of project-first navigation, so it is the flag's to
   *  offer. With the flag off there is no Feed tab and no way to reach one, so
   *  a `?view=feed` link shared from a colleague who HAS the flag has to land
   *  on the board rather than on a view with no tab to leave it by. */
  const feedEnabled = useProjectFirstNav();
  const viewerId = session?.user?.id ?? null;
  const [savedAssignee, setSavedAssignee] = useLocalStorage<string | null>(
    LOCALSTORAGE_KEYS.taskBoardAssignee(org.id, viewerId ?? ""),
    null,
  );
  // Filters + layout live in the URL, so a refresh or a shared link keeps them.
  const {
    filters: urlFilters,
    setFilters,
    layout: urlLayout,
    setLayout,
    groupBy,
    subgroupBy,
    setGroupBy,
    setSubgroupBy,
    sortBy,
    sortDirection,
    setSortBy,
    setSortDirection,
  } = useBoardSearch(
    {
      layout: "board",
      assignee:
        viewerId === null
          ? null
          : savedAssigneeDefault(
              savedAssignee,
              membersData ? new Set(memberByUserId.keys()) : null,
            ),
      groupBy: "status",
      sprint: currentSprintId(sprints),
    },
    (assignee) => {
      if (viewerId !== null) setSavedAssignee(assignee);
    },
  );
  const filters = {
    ...urlFilters,
    sprint: resolveSprintFilter(urlFilters.sprint, sprints),
    // The scope already is the project; a `?repo=` carried into it would
    // narrow by a control this board does not show.
    project: scopeId ? null : urlFilters.project,
  };
  /** The sprint a new card is planned into: the one the board is showing,
   *  unless that one is closed and takes no new cards. */
  const activeSprintId =
    sprints.find(
      (sprint) => sprint.id === filters.sprint && sprint.state !== "closed",
    )?.id ?? null;
  const layout = enabledLayout(urlLayout, feedEnabled);
  const grouping = {
    groupBy,
    subgroupBy,
    onGroupByChange: setGroupBy,
    onSubgroupByChange: setSubgroupBy,
  };
  const sorting = {
    sortBy,
    sortDirection,
    onSortByChange: setSortBy,
    onSortDirectionChange: setSortDirection,
  };
  const [toggledGroups, setToggledGroups] = useState<
    ReadonlyMap<string, boolean>
  >(new Map());
  /** The board's buckets, closed over every repo a loaded card names so the
   *  "No project" bucket cannot claim a card that plainly has one. */
  const projectIndex = useProjectIndex(items, repos);
  /** The projects a card can be stamped for — the same reachability-gated
   *  subset the task dialog's Project picker offers, reused by the bulk bar. */
  const projectEntries = stampableEntries(projectIndex);
  /** What a new card inherits: the board's own project, else the active
   *  Project filter's, so a card made while narrowed to a project belongs to
   *  it. */
  const activeProjectStamp = scopedProject
    ? { repo: projectRepo(scopedProject), virtualMcpId: scopedProject.id }
    : stampFor(
        filters.project
          ? (entryForFilter(filters.project, projectIndex) ?? null)
          : null,
      );
  const [preferences] = usePreferences();
  const columnVisibility = useLaneVisibility();
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const toggleSelect = (id: string) =>
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectAllInLane = (status: string) =>
    setSelection((prev) => {
      const next = new Set(prev);
      for (const item of visibleItems)
        if (item.status === status) next.add(item.id);
      return next;
    });
  const clearSelection = () => setSelection(new Set());
  // A filter change can hide selected cards the same way the list-view toggle does.
  const handleFiltersChange = (next: TaskFilters) => {
    setFilters(next);
    clearSelection();
  };
  // Create only: an existing card is addressed by its path, not by state.
  const [dialogOpen, setDialogOpen] = useState(false);
  // Status a newly-created task should start in (set by a lane's "+"); null for
  // the generic "New task" button.
  const [createStatus, setCreateStatus] = useState<TaskBoardItemStatus | null>(
    null,
  );
  useTaskBoardRulesLive();
  const { setTaskId } = usePanelActions();
  const { create } = useThreadActions();
  const studio = useStudioTools();
  const navigate = useNavigate();
  /** Scoped, the gear opens the PROJECT's settings; only the org-wide board
   *  has board settings of its own. */
  const openBoardSettings = () => {
    if (scopedProject) {
      navigate({
        to: "/$org/projects/$agentId/settings",
        params: { org: org.slug, agentId: scopedProject.id },
      });
      return;
    }
    navigate({
      to: "/$org/settings/task-board",
      params: { org: org.slug },
    });
  };
  const boardSettingsLabel = scopedProject
    ? t("taskBoard.taskFilters.projectSettingsLabel")
    : undefined;
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
  const { taskKey: taskKeyParam } = useParams({ strict: false }) as {
    taskKey?: string;
  };
  const openTaskKey = taskKeyParam;
  /** Where this mount writes a card's address. Every open, close and
   *  canonicalization goes through it. */
  const taskAddress = (key: string | undefined) => ({
    params: (prev: Record<string, unknown>) => ({ ...prev, taskKey: key }),
    search: (prev: Record<string, unknown>) => prev,
  });
  /** Resolved against the ORG's cards, not the scoped slice: a link from
   *  outside the project must open rather than redirect away as stale. */
  const openItem = findTaskByKeyOrId(orgItems, openTaskKey) ?? null;
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
        to: ".",
        ...taskAddress(undefined),
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
    taskMatchesFilters(item, filters, projectIndex),
  );
  /** Bulk actions read the selection reconciled against what is on screen: a
   *  filter change must not leave a hidden card's id queued for a move, an
   *  assign — or a delete. */
  const selectedIds = visibleSelection(selection, visibleItems);
  const listLevels = groupLevels(groupBy, subgroupBy);
  // Grouped by status, hidden lanes get their own collapsed section; otherwise
  // the list has no "Hidden columns" drawer and drops them outright.
  const shownListItems = listLevels.includes("status")
    ? visibleItems
    : visibleItems.filter(
        (item) =>
          !HIDDEN_STATUSES.includes(item.status) ||
          isLaneShown(item.status, preferences.taskBoardLaneVisibility),
      );
  // Sorted before grouping, so every group reads in the chosen order too.
  const visibleListItems =
    sortBy === null
      ? shownListItems
      : sortListItems(shownListItems, sortBy, sortDirection, {
          memberNames: new Map(
            members.map((m) => [m.userId, m.user?.name ?? m.userId]),
          ),
          superAgentName: t("taskBoard.taskFilters.assigneeSuperAgent"),
          index: projectIndex,
        });

  /**
   * Keep a newly created card visible: drop the project filter when the card
   * would fall outside it. Widening back is visible; an empty lane is not.
   *
   * Calls `setFilters` rather than `handleFiltersChange`, which also clears the
   * selection: creating a card must not discard a bulk selection.
   *
   * Only the project filter is rescued. A board narrowed by assignee or search
   * can still swallow a new card — that predates this and is not a promise
   * made here.
   */
  const widenProjectFilterFor = (card: AttributableTask) => {
    const next = filterAfterCreate(card, filters.project, projectIndex);
    if (next !== filters.project) {
      setFilters({ ...filters, project: next });
    }
  };

  const openCreate = () => {
    setCreateStatus(null);
    setDialogOpen(true);
  };

  const openCreateInLane = (status: TaskBoardItemStatus) => {
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
    navigate({ to: ".", ...taskAddress(taskRouteSegment(org.slug, item)) });
  };

  // The API refuses shapes the board can't show (a subtask's subtask, an
  // epic under a card), so its reason is worth showing as-is.
  const onHierarchyError = (err: unknown) =>
    toast.error(
      err instanceof Error && err.message
        ? err.message
        : t("taskBoard.taskBoard.actionError"),
    );
  const epicBoard = {
    items,
    memberByUserId,
    onSetStatus: (id: string, status: TaskBoardItemStatus) =>
      actions.update.mutate({ id, status }),
    orgSlug: org.slug,
    setParent: (id: string, parentId: string | null) =>
      actions.update.mutate({ id, parentId }, { onError: onHierarchyError }),
    setEpic: (id: string, isEpic: boolean) =>
      actions.update.mutate({ id, isEpic }, { onError: onHierarchyError }),
    onOpen: openTask,
    onShowEpics: () => {
      const address = taskAddress(undefined);
      navigate({
        to: ".",
        params: address.params,
        search: (prev: Record<string, unknown>) => ({
          ...address.search(prev),
          view: "epics",
        }),
      });
    },
    onCreateChild: (parent: TaskBoardItem, title: string) =>
      actions.create
        .mutateAsync({
          title,
          status: "todo",
          repo: parent.repo,
          virtualMcpId: parent.virtualMcpId,
          parentId: parent.id,
        })
        .catch(onHierarchyError),
  };
  const createEpic = () =>
    actions.create
      .mutateAsync({
        title: t("taskBoard.epics.newEpicTitle"),
        status: "todo",
        isEpic: true,
        ...activeProjectStamp,
      })
      .then(({ item }) => openTask(item), onHierarchyError);

  const closeCreate = () => {
    setDialogOpen(false);
    setCreateStatus(null);
  };

  if (isLoading && items.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    );
  }

  if (staleTaskKey) {
    return <Navigate to="." {...taskAddress(undefined)} replace />;
  }

  if (canonicalKey && canonicalKey !== openTaskKey) {
    return <Navigate to="." {...taskAddress(canonicalKey)} replace />;
  }

  /** Board / List / Epics, and Feed behind the flag. */
  const layoutTabs = (
    <Page.Tabs>
      {feedEnabled && (
        <Page.Tab
          active={layout === "feed"}
          aria-label={t("taskBoard.taskBoard.layoutViewAriaLabel", {
            label: t("common.taskBoard.feedView"),
          })}
          onClick={() => {
            setLayout("feed");
            clearSelection();
          }}
        >
          {t("common.taskBoard.feedView")}
        </Page.Tab>
      )}
      <Page.Tab
        active={layout === "board"}
        aria-label={t("taskBoard.taskBoard.layoutViewAriaLabel", {
          label: t("common.taskBoard.boardView"),
        })}
        onClick={() => setLayout("board")}
      >
        {t("common.taskBoard.boardView")}
      </Page.Tab>
      <Page.Tab
        active={layout === "list"}
        aria-label={t("taskBoard.taskBoard.layoutViewAriaLabel", {
          label: t("common.taskBoard.listView"),
        })}
        onClick={() => {
          setLayout("list");
          clearSelection();
        }}
      >
        {t("common.taskBoard.listView")}
      </Page.Tab>
      <Page.Tab
        active={layout === "epics"}
        aria-label={t("taskBoard.taskBoard.layoutViewAriaLabel", {
          label: t("taskBoard.epics.tab"),
        })}
        onClick={() => {
          setLayout("epics");
          clearSelection();
        }}
      >
        {t("taskBoard.epics.tab")}
      </Page.Tab>
    </Page.Tabs>
  );

  const listRow = (item: TaskBoardItem) => (
    <ListRow
      key={item.id}
      item={item}
      assignee={
        item.assigneeId ? memberByUserId.get(item.assigneeId) : undefined
      }
      assignedBy={
        item.assignedBy ? memberByUserId.get(item.assignedBy) : undefined
      }
      members={members}
      onOpen={() => openTask(item)}
      onStatusChange={(status) =>
        actions.update.mutate({ id: item.id, status })
      }
      onRename={(title) => actions.update.mutate({ id: item.id, title })}
      onPriorityChange={(priority) =>
        actions.update.mutate({ id: item.id, priority })
      }
      onTagsChange={(tagIds) => actions.update.mutate({ id: item.id, tagIds })}
      onDueDateChange={(dueDate) =>
        actions.update.mutate({ id: item.id, dueDate })
      }
      onAssign={(userId) => {
        if (blockSuperAgentWithoutRepository(userId)) return;
        actions.update.mutate(
          { id: item.id, assigneeId: userId },
          { onError: onDelegateError },
        );
      }}
    />
  );

  /** The board itself — header, toolbar, lanes. Hoisted so wrapping it
   *  below does not reindent every line of it. */
  const boardContent = (
    <>
      {/* A task takes the header over: the board stays mounted behind it so
          its scroll and dnd survive, and these would otherwise paint over
          the task's own trail and title. */}
      {!openItem && (
        <>
          {/* From the scope, so two overrides cannot disagree. */}
          <Page.Title>
            {feedEnabled
              ? t("sidebar.navDestinations.spineTasks")
              : t("taskBoard.taskBoard.tasksTitle")}
          </Page.Title>
          <Page.Actions
            secondary={
              <>
                <SprintSwitcher
                  sprints={sprints}
                  value={filters.sprint}
                  onChange={(sprint) =>
                    handleFiltersChange({ ...filters, sprint })
                  }
                />
                {/* Epics lists every epic; the board's filters don't apply to it. */}
                {items.length > 0 && layout !== "epics" && (
                  <>
                    {/* No width swap: these three are ~100px together, so there
                      is no panel narrow enough to be worth trading them for a
                      drawer of the chip pickers they replaced. */}
                    <div className="flex items-center gap-2">
                      <SearchToggle
                        value={filters.search}
                        onChange={(search) =>
                          handleFiltersChange({ ...filters, search })
                        }
                        label={t("taskBoard.taskFilters.searchLabel")}
                        placeholder={t(
                          "taskBoard.taskFilters.searchPlaceholder",
                        )}
                        clearLabel={t("taskBoard.taskFilters.searchClearLabel")}
                      />
                      <TaskFilterButton
                        filters={filters}
                        items={items}
                        members={members}
                        tags={orgTags}
                        sprints={sprints}
                        index={projectIndex}
                        scoped={scopeId !== null}
                        onChange={handleFiltersChange}
                      />
                      {/* A phone's header fits search, filter and settings; view tuning stays on wider screens. */}
                      <div className="contents max-md:hidden">
                        {layout === "list" ? (
                          <>
                            <GroupByButton {...grouping} />
                            <SortByButton {...sorting} />
                          </>
                        ) : (
                          <ColumnsButton
                            all={CANONICAL_COLUMN_KEYS}
                            hidden={columnVisibility.hidden}
                            onToggle={columnVisibility.setLaneShown}
                          />
                        )}
                      </div>
                    </div>
                  </>
                )}
                <BoardSettingsButton
                  onClick={openBoardSettings}
                  label={boardSettingsLabel}
                />
              </>
            }
          >
            <TaskBoardAdminControls />
            <TaskBoardAnalyticsButton project={scopeId} />
            {!feedEnabled && <AgenticSetupButton />}
            {layout === "epics" ? (
              <Button size="sm" onClick={createEpic}>
                <Plus size={16} />
                {t("taskBoard.epics.newEpic")}
              </Button>
            ) : (
              <Button size="sm" onClick={openCreate}>
                <Plus size={16} />
                <span className="max-md:sr-only">
                  {t("taskBoard.taskBoard.newTask")}
                </span>
              </Button>
            )}
          </Page.Actions>
          <Panel.Toolbar.Left.Portal>{layoutTabs}</Panel.Toolbar.Left.Portal>
          <Panel.Toolbar.Right.Portal>
            {feedEnabled && (
              <AgentsRunningBadge items={items} onOpen={openTask} />
            )}
          </Panel.Toolbar.Right.Portal>
        </>
      )}

      <div className="mx-auto w-full max-w-[1680px] px-4 sm:px-8">
        <TaskBoardAdminBanner />
      </div>
      <AppliedFiltersBar
        filters={filters}
        items={items}
        members={members}
        tags={orgTags}
        sprints={sprints}
        index={projectIndex}
        onChange={handleFiltersChange}
        view={layout === "list" ? { grouping, sorting } : undefined}
      />

      {items.length === 0 ? (
        <div className="mx-auto w-full max-w-[1680px] px-4 pt-6 sm:px-8">
          <div className="surface px-4 py-12 text-center text-sm text-muted-foreground">
            {t("taskBoard.taskBoard.noTasksYet")}
          </div>
        </div>
      ) : visibleItems.length === 0 ? (
        <div className="mx-auto w-full max-w-[1680px] px-4 pt-6 sm:px-8">
          <div className="flex flex-col items-center gap-3 surface px-4 py-12 text-center text-sm text-muted-foreground">
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
      ) : layout === "feed" ? (
        <FeedView
          items={visibleListItems}
          index={projectIndex}
          memberByUserId={memberByUserId}
          onCompose={(input) =>
            actions.create.mutate({
              ...input,
              ...(scopedProject ? activeProjectStamp : {}),
            })
          }
          onOpen={openTask}
        />
      ) : layout === "epics" ? (
        <div className="min-h-0 flex-1 overflow-y-auto pb-16 px-4 pt-6 sm:px-8">
          <div className="mx-auto w-full max-w-[960px]">
            <EpicsView />
          </div>
        </div>
      ) : layout === "board" ? (
        <Lanes
          visible={!openItem}
          items={laneCards(visibleItems, items)}
          members={members}
          memberByUserId={memberByUserId}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onSelectAllInLane={selectAllInLane}
          onOpen={openTask}
          onCreate={openCreateInLane}
          onMove={(ids, status, sortOrder, priorities, onSettled) => {
            // Cards dragged together land as a consecutive run ending at the
            // drop point, keeping `ids` order.
            const orders = runSortOrders(sortOrder, ids.length);
            ids.forEach((id, i) =>
              actions.update.mutate(
                {
                  id,
                  status,
                  sortOrder: orders[i]!,
                  ...(priorities.has(id) && { priority: priorities.get(id) }),
                },
                { onSettled: () => onSettled(id) },
              ),
            );
          }}
          onAssign={(id, userId) => {
            if (blockSuperAgentWithoutRepository(userId)) return;
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
            if (blockSuperAgentWithoutRepository(SUPER_AGENT_ASSIGNEE_ID))
              return;
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
        <div className="min-h-0 flex-1 overflow-y-auto pb-16 px-4 pt-6 sm:px-8">
          <div className="mx-auto flex w-full max-w-[1680px] flex-col gap-2">
            {groupBy === null ? (
              visibleListItems.map(listRow)
            ) : (
              <ListGroupTree
                groups={groupListItems(visibleListItems, listLevels, {
                  memberIds: members.map((m) => m.userId),
                  tagIds: orgTags.map((tag) => tag.id),
                  index: projectIndex,
                })}
                depth={0}
                toggled={toggledGroups}
                onToggle={(group, siblings, all) =>
                  setToggledGroups((prev) =>
                    toggleGroupOpen(prev, group, siblings, all),
                  )
                }
                renderRow={listRow}
                heading={{ memberByUserId, orgTags, index: projectIndex }}
              />
            )}
          </div>
        </div>
      )}
    </>
  );

  /** Full-width so each region's scroll container spans the whole panel — the
   *  max-width lives on the *content* inside (header + lanes), so the mouse can
   *  sit in the empty margins on wide monitors and still scroll the board. */
  const page = (
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
          onSetSprint={(sprintId) =>
            actions.update.mutate(
              { id: openItem.id, sprintId },
              { onError: onDelegateError },
            )
          }
          onSubmit={(input) => {
            if (blockSuperAgentWithoutRepository(input.assigneeId)) {
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
              virtualMcpId: openItem.virtualMcpId,
              dueDate: openItem.dueDate,
              tagIds: openItem.tags.map((tag) => tag.id),
              sprintId:
                sprints.find(
                  (sprint) =>
                    sprint.id === openItem.sprintId &&
                    sprint.state !== "closed",
                )?.id ?? null,
            });
            widenProjectFilterFor(openItem);
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
            if (blockSuperAgentWithoutRepository(SUPER_AGENT_ASSIGNEE_ID))
              return;
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
              panel: "site-editor",
            });
          }}
        />
      )}

      <TaskBoardItemDialog
        key={dialogOpen ? `new-${createStatus ?? "default"}` : "closed"}
        open={dialogOpen}
        onClose={closeCreate}
        defaultStatus={createStatus ?? undefined}
        defaultProject={activeProjectStamp}
        defaultSprintId={activeSprintId}
        isSaving={actions.create.isPending}
        onSubmit={(input) => {
          if (blockSuperAgentWithoutRepository(input.assigneeId)) {
            closeCreate();
            return;
          }
          actions.create.mutate(input);
          widenProjectFilterFor(input);
          closeCreate();
        }}
      />

      <RepositoryImportPicker
        mode="link"
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
          projectEntries={projectEntries}
          onSetProject={(stamp) => {
            for (const id of selectedIds)
              actions.update.mutate({ id, ...stamp });
            clearSelection();
          }}
          onMoveTo={(status) => {
            for (const id of selectedIds) actions.update.mutate({ id, status });
            clearSelection();
          }}
          onSetSprint={(sprintId) => {
            for (const id of selectedIds)
              actions.update.mutate({ id, sprintId });
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
            if (blockSuperAgentWithoutRepository(userId)) return;
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
                  if (blockSuperAgentWithoutRepository(SUPER_AGENT_ASSIGNEE_ID))
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
  return <EpicBoardProvider value={epicBoard}>{page}</EpicBoardProvider>;
}

/**
 * Small prompt shown when Auto-fix is used in an org with no GitHub connection.
 * The Super Agent needs GitHub to open a PR, so we connect first. Once the
 * connection lands the card's Run button (the auto-fix flow) works on the
 * next click.
 */
/**
 * Floating pill toolbar that appears once at least one card is selected —
 * count, a bulk "Actions" menu (move / tag / priority / delete), a quick
 * "move to" shortcut, and a close button that clears the selection.
 */
function SelectionBar({
  count,
  members,
  projectEntries,
  onSetProject,
  onMoveTo,
  onSetSprint,
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
  /** The projects a card can be stamped for — same set as the task dialog. */
  projectEntries: ProjectIndexEntry[];
  /** Bulk-assign the project with its repository, or clear both. */
  onSetProject: (stamp: ReturnType<typeof stampFor>) => void;
  onMoveTo: (status: TaskBoardItemStatus) => void;
  /** Bulk-plan into a sprint, or null for the backlog. */
  onSetSprint: (sprintId: string | null) => void;
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
  const openSprints = useTaskBoardSprints().filter(
    (sprint) => sprint.state !== "closed",
  );
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 z-20 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-2 rounded-full bg-background px-3 py-2 shadow-edge">
        <span className="pl-1 text-sm font-medium text-foreground">
          {t("taskBoard.taskBoard.selectedCount", { count })}
        </span>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              {t("taskBoard.taskBoard.actionsButton")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" side="top">
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                {t("taskBoard.taskBoard.moveToButton")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {CANONICAL_COLUMN_KEYS.map((status) => (
                  <DropdownMenuItem
                    key={status}
                    onClick={() => onMoveTo(status)}
                  >
                    {laneHeader(status, t).label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {openSprints.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  {t("taskBoard.sprints.moveToSprint")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-56">
                  <DropdownMenuItem onClick={() => onSetSprint(null)}>
                    <Inbox01 size={14} className="text-muted-foreground" />
                    {t("taskBoard.sprints.backlog")}
                  </DropdownMenuItem>
                  {openSprints.map((sprint) => (
                    <DropdownMenuItem
                      key={sprint.id}
                      onClick={() => onSetSprint(sprint.id)}
                    >
                      <Zap size={14} className="text-muted-foreground" />
                      <span className="truncate">{sprintLabel(sprint, t)}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
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
            {projectEntries.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  {t("taskBoard.taskBoard.assignProjectButton")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-64">
                  <DropdownMenuItem
                    onClick={() => onSetProject(stampFor(null))}
                  >
                    {t("taskBoard.taskDialog.noProject")}
                  </DropdownMenuItem>
                  {projectEntries.map((entry) => (
                    <DropdownMenuItem
                      key={entry.id}
                      className="gap-2"
                      onClick={() => onSetProject(stampFor(entry))}
                    >
                      <ProjectEntryRow entry={entry} />
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
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
          <Button variant="outline" size="sm" onClick={onAutoFix}>
            <Lightning01 className="size-3.5" />
            {t("taskBoard.taskBoard.autoFix")}
          </Button>
        )}

        {onRerun && (
          <Button variant="outline" size="sm" onClick={onRerun}>
            <RefreshCw01 className="size-3.5" />
            {t("taskBoard.taskBoard.rerun")}
          </Button>
        )}

        <Button
          variant="ghost"
          size="icon"
          aria-label={t("taskBoard.taskBoard.clearSelectionButton")}
          title={t("taskBoard.taskBoard.clearSelectionButton")}
          onClick={onClear}
          className="shrink-0 text-muted-foreground"
        >
          <X size={16} />
        </Button>
      </div>
    </div>
  );
}

/** Where a card sits locally: while a drag is in flight, and then until the
 *  server's optimistic patch catches up. */
interface Placement {
  status: TaskBoardItemStatus;
  sortOrder: number;
  /** Set when the drag crossed swimlanes, so the card previews in its new well. */
  priority?: TaskBoardItemPriority;
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

/** Lane visibility persists per person, so the choice survives a reload. The
 *  toolbar menu and the board read the same preference. */
function useLaneVisibility() {
  const [preferences, setPreferences] = usePreferences();
  const { lanes, hidden } = laneVisibility(preferences.taskBoardLaneVisibility);
  const setLaneShown = (status: string, shown: boolean) =>
    setPreferences((prev) => ({
      ...prev,
      taskBoardLaneVisibility: {
        ...prev.taskBoardLaneVisibility,
        [status]: shown,
      },
    }));
  return { lanes, hidden, setLaneShown };
}

/** A lane's order on screen: its critical well first, then the rest. */
function byLaneOrder(a: TaskBoardItem, b: TaskBoardItem) {
  return (
    Number(isCriticalTask(b)) - Number(isCriticalTask(a)) || bySortOrder(a, b)
  );
}

/** A lane's own droppable or its critical well's, rather than a card. */
function isWellId(id: string) {
  return (
    id.startsWith(LANE_DROPPABLE_PREFIX) ||
    id.startsWith(CRITICAL_DROPPABLE_PREFIX)
  );
}

function Lanes({
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
  items: TaskBoardItem[];
  members: Member[];
  memberByUserId: Map<string, Member>;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onSelectAllInLane: (status: string) => void;
  onOpen: (item: TaskBoardItem) => void;
  onCreate: (status: TaskBoardItemStatus) => void;
  onMove: (
    ids: string[],
    status: TaskBoardItemStatus,
    sortOrder: number,
    /** Cards whose drop crossed swimlanes, with the priority that puts them there. */
    priorities: Map<string, TaskBoardItemPriority>,
    /** A card's write settled: drop its override so the card shows what the
     *  server has, and a later edit (say, its priority) isn't masked by it. */
    onSettled: (id: string) => void,
  ) => void;
  onAutoFix?: (item: TaskBoardItem) => void;
  onRerun?: (item: TaskBoardItem) => void;
  onAssign?: (id: string, userId: string | null) => void;
  onPriorityChange?: (id: string, priority: TaskBoardItemPriority) => void;
  onTypeChange?: (id: string, type: TaskBoardItemType) => void;
  onDueDateChange?: (id: string, iso: string) => void;
  /** False while the task detail has the panel — see `useFlipLanes`. */
  visible: boolean;
}) {
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
      // A board that scrolls vertically keeps the wheel for that.
      if (node.scrollHeight > node.clientHeight) return;
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
        server.sortOrder === placement.sortOrder &&
        (!placement.priority || server.priority === placement.priority)
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

  const swimlanes = useProjectFirstNav();
  const laneOrder = swimlanes ? byLaneOrder : bySortOrder;
  const laneItems = (status: string) =>
    placed.filter((item) => item.status === status).sort(laneOrder);

  const {
    lanes: boardLanes,
    hidden: hiddenLanes,
    setLaneShown,
  } = useLaneVisibility();
  const collapsedLanes = preferences.collapsedTaskBoardLanes;
  const anyCritical = placed.some(isCriticalTask);
  const labelledLane = boardLanes.find(
    (status) => !collapsedLanes.includes(status),
  );
  const toggleLaneCollapsed = (status: string) =>
    setPreferences((prev) => ({
      ...prev,
      collapsedTaskBoardLanes: prev.collapsedTaskBoardLanes.includes(status)
        ? prev.collapsedTaskBoardLanes.filter((s) => s !== status)
        : [...prev.collapsedTaskBoardLanes, status],
    }));

  /** Resolved against `placed` rather than dnd-kit's `over.data`, which is a
   *  ref and can't be read during render. */
  const laneOf = (overId: string | number | undefined) =>
    dropLane({
      overId,
      statusOf: (cardId) => placed.find((item) => item.id === cardId)?.status,
    });

  // A card inside a multi-selection drags the whole selection, grabbed card
  // first so it leads the run and the others follow in order.
  const groupOf = (id: string) =>
    selectedIds.has(id) && selectedIds.size > 1
      ? [id, ...Array.from(selectedIds).filter((other) => other !== id)]
      : [id];

  const place = (
    ids: string[],
    status: TaskBoardItemStatus,
    slot: number,
    swimlane: "critical" | "improvements" | null = null,
  ) => {
    const orders = runSortOrders(slot, ids.length);
    setOverrides((prev) => {
      const next = new Map(prev);
      ids.forEach((id, i) => {
        const saved = items.find((item) => item.id === id);
        const priority = saved && swimlane && swimlanePriority(saved, swimlane);
        next.set(id, {
          status,
          sortOrder: orders[i]!,
          ...(priority && { priority }),
        });
      });
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

  const swimlaneUnder = (
    overId: string | number | undefined,
    draggedId: string,
    lane: string,
  ) => {
    const saved = items.find((item) => item.id === draggedId);
    return swimlanes && saved
      ? dropSwimlane({
          overId,
          itemOf: (cardId) => placed.find((item) => item.id === cardId),
          fromStatus: saved.status,
          toStatus: lane,
        })
      : null;
  };

  const handleDragOver = (event: DragOverEvent) => {
    const id = String(event.active.id);
    const lane = laneOf(event.over?.id);
    const current = placed.find((item) => item.id === id);
    const saved = items.find((item) => item.id === id);
    if (!lane || !current || !saved) return;
    const swimlane = swimlaneUnder(event.over?.id, id, lane);
    const priority =
      (swimlane && swimlanePriority(saved, swimlane)) || undefined;
    if (current.status === lane && overrides.get(id)?.priority === priority) {
      return;
    }
    // Preview the group in the lane or well under the cursor so the gap opens there.
    const ids = groupOf(id);
    const overId = String(event.over?.id ?? "");
    const target = laneItems(lane).filter((item) => !ids.includes(item.id));
    place(
      ids,
      lane,
      insertSortOrder(target, isWellId(overId) ? null : overId, id),
      swimlane,
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
    const to = overId.startsWith(CRITICAL_DROPPABLE_PREFIX)
      ? laneNow.filter((item) => isCriticalTask(item) && item.id !== id).length
      : overId.startsWith(LANE_DROPPABLE_PREFIX)
        ? laneNow.length - 1
        : laneNow.findIndex((item) => item.id === overId);
    const reordered =
      from === -1 || to === -1
        ? laneNow
        : arrayMove(laneNow, from, Math.min(to, laneNow.length - 1));

    // Crossing between Critical and Improvements is a priority change.
    const swimlane = swimlaneUnder(event.over?.id, id, lane);
    const priorities = new Map<string, TaskBoardItemPriority>();
    for (const groupId of ids) {
      const saved = items.find((item) => item.id === groupId);
      const priority = saved && swimlane && swimlanePriority(saved, swimlane);
      if (priority) priorities.set(groupId, priority);
    }

    // Dropped back exactly where it started — skip the write entirely.
    const serverOrder = items
      .filter((item) => item.status === lane)
      .sort(laneOrder)
      .map((item) => item.id)
      .join();
    if (
      priorities.size === 0 &&
      serverOrder === reordered.map((item) => item.id).join()
    ) {
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
    place(ids, lane, slot, swimlane);
    setLandedIds(ids);
    const written = new Map(
      runSortOrders(slot, ids.length).map((order, i) => [ids[i]!, order]),
    );
    onMove(ids, lane, slot, priorities, (settledId) =>
      setOverrides((prev) => {
        // A newer drag of the same card owns its override now.
        const current = prev.get(settledId);
        if (
          !current ||
          current.status !== lane ||
          current.sortOrder !== written.get(settledId)
        ) {
          return prev;
        }
        const next = new Map(prev);
        next.delete(settledId);
        return next;
      }),
    );
  };

  const activeItem = activeId
    ? placed.find((item) => item.id === activeId)
    : null;
  const activeGroup = activeId ? groupOf(activeId) : [];
  // Dropping here starts the lane's automations when the drag brings in cards
  // nobody owns from another lane: a person's card is never taken over, and a
  // card staying in its lane is no move. Read from the saved cards, not the
  // preview, which already shows them in the lane under the cursor.
  const dropBringsUnownedCards = (lane: string) =>
    activeGroup.length > 0 &&
    activeGroup.every((id) => {
      const saved = items.find((item) => item.id === id);
      return !!saved && !saved.assigneeId && saved.status !== lane;
    });

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={boardCollisions}
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
      {/* With swimlanes the whole board scrolls as one, so its rows stay aligned. */}
      <div
        ref={attachBoard}
        className={cn(
          "min-h-0 flex-1 overflow-x-auto",
          swimlanes && "overflow-y-auto",
        )}
      >
        {/* Padding lives on the capped row (not the scroll container) so its
            left edge matches the header's max-w + px exactly. Bottom breathing
            room is handled per-lane by each column's own scrollable div — a pb
            here would eat into this row's h-full and cut every column short,
            since it no longer wraps a single page-level scroll. */}
        {/* Inline tracks, because their count is the lane count — see
            `boardGridColumns`. */}
        <div
          className={cn(
            "mx-auto grid w-full max-w-[1680px]",
            // Lanes subgrid these rows so the swimlanes align across columns.
            swimlanes
              ? "min-h-full grid-rows-[auto_auto_1fr] gap-x-3 pb-6"
              : "h-full gap-3",
            "px-4 pt-6 sm:px-8",
          )}
          style={{
            gridTemplateColumns: boardGridColumns({
              lanes: boardLanes,
              collapsed: collapsedLanes,
              hasHiddenTail: hiddenLanes.length > 0,
            }),
          }}
        >
          {boardLanes.map((status) => (
            <Lane
              key={status}
              status={status}
              items={laneItems(status)}
              members={members}
              memberByUserId={memberByUserId}
              selectedIds={selectedIds}
              // Highlight the lane the drag currently sits in. Derived from the
              // preview rather than `useDroppable`'s `isOver`, which goes false
              // whenever a card (not the lane) is the drop target and would
              // strobe the background.
              isTarget={activeItem?.status === status}
              firesOnDrop={
                activeItem?.status === status && dropBringsUnownedCards(status)
              }
              draggedCount={activeGroup.length}
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
                boardLanes.length > 1
                  ? () => setLaneShown(status, false)
                  : undefined
              }
              collapsed={collapsedLanes.includes(status)}
              onToggleCollapsed={() => toggleLaneCollapsed(status)}
              labelled={status === labelledLane}
              anyCritical={anyCritical}
              swimlanes={swimlanes}
            />
          ))}
          {hiddenLanes.length > 0 && (
            <HiddenLanes
              statuses={hiddenLanes}
              countOf={(status) => laneItems(status).length}
              onShow={(status) => setLaneShown(status, true)}
              swimlanes={swimlanes}
            />
          )}
        </div>
      </div>
      {/* Portal to body so the overlay's `position: fixed` resolves against the
          viewport rather than the workspace Panel's transformed containing
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
                className="w-full shadow-lift"
              />
              {activeGroup.length > 1 && (
                <span className="absolute -top-2 -right-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-foreground px-1.5 text-2xs font-semibold text-background">
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
  countOf,
  onShow,
  swimlanes,
}: {
  swimlanes: boolean;
  statuses: string[];
  countOf: (status: string) => number;
  onShow: (status: string) => void;
}) {
  const t = useT();
  return (
    <details
      className={cn("group h-full min-w-0 py-1", swimlanes && "row-span-3")}
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight
          size={14}
          className="shrink-0 transition-transform group-open:rotate-90"
        />
        {t("taskBoard.taskBoard.hiddenColumns")}
      </summary>
      <div className="flex flex-col gap-2 px-1 pt-1">
        {statuses.map((status) => {
          const { label, visual } = laneHeader(status, t);
          const LaneIcon = visual.icon;
          return (
            <div
              key={status}
              data-hidden-lane={status}
              className="surface flex items-center gap-2 px-3 py-2.5"
            >
              <LaneIcon
                size={15}
                className={cn("shrink-0", visual.iconClassName)}
              />
              <span className="text-sm font-medium text-foreground">
                {label}
              </span>
              <span className="ml-auto text-2xs font-medium text-muted-foreground">
                {countOf(status)}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("taskBoard.taskBoard.laneMenuAriaLabel", {
                      lane: label,
                    })}
                    className="shrink-0 text-muted-foreground"
                  >
                    <DotsHorizontal className="size-3.75" />
                  </Button>
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
  items,
  members,
  memberByUserId,
  selectedIds,
  isTarget,
  firesOnDrop,
  draggedCount,
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
  collapsed,
  onToggleCollapsed,
  labelled,
  anyCritical,
  swimlanes,
}: {
  status: TaskBoardItemStatus;
  items: TaskBoardItem[];
  members: Member[];
  memberByUserId: Map<string, Member>;
  selectedIds: Set<string>;
  isTarget: boolean;
  /** Dropping the dragged cards here would start this lane's automations. */
  firesOnDrop: boolean;
  draggedCount: number;
  /** Cards riding in the DragOverlay — held in the layout as gaps. */
  hiddenIds: string[];
  /** Cards that just landed from a drop — they play the settle animation. */
  landedIds: string[];
  onToggleSelect: (id: string) => void;
  onSelectAllInLane: (status: string) => void;
  onOpen: (item: TaskBoardItem) => void;
  onCreate: (status: TaskBoardItemStatus) => void;
  onAutoFix?: (item: TaskBoardItem) => void;
  onRerun?: (item: TaskBoardItem) => void;
  onAssign?: (id: string, userId: string | null) => void;
  onPriorityChange?: (id: string, priority: TaskBoardItemPriority) => void;
  onTypeChange?: (id: string, type: TaskBoardItemType) => void;
  onDueDateChange?: (id: string, iso: string) => void;
  /** Present only for a hidden-by-default lane, which can be put back away. */
  onHide?: () => void;
  /** Drawn as a narrow strip with its label and count, cards out of view. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** The one lane that prints the swimlane names; the rest keep their height. */
  labelled: boolean;
  anyCritical: boolean;
  /** Critical / Improvements wells, behind the new navigation. */
  swimlanes: boolean;
}) {
  const t = useT();
  const { label, visual } = laneHeader(status, t);
  const LaneIcon = visual.icon;
  const [rulesOpen, setRulesOpen] = useState(false);
  const takers = useEntryAutomations(status)
    .filter((automation) => automation.active)
    .map((automation) => automation.name);
  const announce = firesOnDrop && takers.length > 0;
  // The lane's own droppable covers the empty space below the last card, so an
  // empty lane (and the area past the end of a short one) still takes a drop.
  const { setNodeRef } = useDroppable({
    id: `${LANE_DROPPABLE_PREFIX}${status}`,
  });
  const criticalWell = hasCriticalWell(status);
  const { setNodeRef: setCriticalRef } = useDroppable({
    id: `${CRITICAL_DROPPABLE_PREFIX}${status}`,
    disabled: !criticalWell || !anyCritical,
  });

  const critical = items.filter(isCriticalTask);
  const rest = items.filter((item) => !isCriticalTask(item));
  const renderCard = (item: TaskBoardItem) => (
    <SortableTaskCard
      key={item.id}
      item={item}
      assignee={
        item.assigneeId ? memberByUserId.get(item.assigneeId) : undefined
      }
      assignedBy={
        item.assignedBy ? memberByUserId.get(item.assignedBy) : undefined
      }
      members={members}
      selected={selectedIds.has(item.id)}
      hidden={hiddenIds.includes(item.id)}
      landed={landedIds.includes(item.id)}
      onToggleSelect={() => onToggleSelect(item.id)}
      onOpen={() => onOpen(item)}
      onAutoFix={onAutoFix ? () => onAutoFix(item) : undefined}
      onRerun={onRerun ? () => onRerun(item) : undefined}
      onAssign={onAssign ? (userId) => onAssign(item.id, userId) : undefined}
      onPriorityChange={
        onPriorityChange
          ? (priority) => onPriorityChange(item.id, priority)
          : undefined
      }
      onTypeChange={
        onTypeChange ? (type) => onTypeChange(item.id, type) : undefined
      }
      onDueDateChange={
        onDueDateChange ? (iso) => onDueDateChange(item.id, iso) : undefined
      }
    />
  );

  if (collapsed) {
    return (
      // The whole strip stays a drop target, so a card can still be dragged
      // into a collapsed lane.
      <div
        ref={setNodeRef}
        data-lane={status}
        data-lane-collapsed=""
        data-drop-target={isTarget || undefined}
        className={cn(
          "group/lane flex h-full min-h-0 min-w-0 flex-col items-center py-1",
          swimlanes && "row-span-3",
        )}
      >
        <div
          className={cn(
            "flex w-full flex-col items-center gap-2 rounded-xl px-1 py-3 transition-colors",
            isTarget ? "bg-muted" : "bg-muted/50",
          )}
        >
          <LaneIcon
            size={15}
            className={cn(
              "shrink-0",
              visual.iconClassName.replace(/\banimate-\S+\b/g, "").trim(),
            )}
          />
          <span className="text-sm font-medium text-foreground [writing-mode:vertical-rl]">
            {label}
          </span>
          <span className="text-2xs font-medium text-muted-foreground">
            {items.length}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t("taskBoard.taskBoard.expandColumnAriaLabel", {
                  lane: label,
                })}
                onClick={onToggleCollapsed}
                className={LANE_ACTION}
              >
                <Maximize2 size={15} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {t("taskBoard.taskBoard.expandColumn")}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    );
  }

  return (
    <div
      // Stable hook for e2e drag specs — lane columns are otherwise only
      // identifiable by their localized label or utility classes.
      data-lane={status}
      data-drop-target={isTarget || undefined}
      className={cn(
        // min-h-0: a grid item's minimum height is its content, so without it
        // every lane grows to the longest one instead of scrolling on its own.
        "group/lane min-h-0 min-w-0 rounded-xl py-1 transition-colors",
        // A phone shows one lane at a time, so aligning wells across lanes only pads them.
        swimlanes
          ? "row-span-3 grid grid-rows-subgrid max-md:flex max-md:flex-col"
          : "flex h-full flex-col",
        announce
          ? "bg-special/15 ring-1 ring-inset ring-special/30"
          : isTarget && "bg-muted/50",
      )}
    >
      {/* Sticky so the column header stays visible while the cards scroll
          vertically under it — needs an opaque bg for that to hide scrolled-
          under cards, so it tracks the lane's own highlight color (solid,
          since bg-muted/50 would let cards show through) rather than a fixed
          one that'd seam against it while a drag is over the lane. */}
      {/* Sticky together, so the drop hint stays in view above the dragged card. */}
      <div
        className={cn(
          "sticky top-0 z-10 flex min-w-0 flex-col transition-colors",
          isTarget ? "bg-muted" : "bg-background",
        )}
      >
        <div className="flex items-center gap-2 px-2 py-1.5">
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
          {/* A wrapped name would push every lane's swimlanes down. */}
          <span
            title={label}
            className="min-w-0 truncate text-sm font-medium text-foreground"
          >
            {label}
          </span>
          <span className="rounded-md bg-muted px-1.5 text-2xs font-medium text-muted-foreground">
            {items.length}
          </span>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t("taskBoard.taskBoard.laneMenuAriaLabel", {
                      lane: label,
                    })}
                    className={cn(LANE_ACTION, "ml-auto")}
                  >
                    <DotsHorizontal size={15} />
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="top">
                {t("taskBoard.taskBoard.laneMenuAriaLabel", { lane: label })}
              </TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setRulesOpen(true)}>
                <Stars02 size={14} />
                {t("taskBoard.columnRules.menuItem")}
              </DropdownMenuItem>
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
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t("taskBoard.taskBoard.newTaskInLaneAriaLabel", {
                  lane: label,
                })}
                onClick={() => onCreate(status)}
                className={LANE_ACTION}
              >
                <Plus size={15} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {t("taskBoard.taskBoard.newTaskInLaneTitle", { lane: label })}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t("taskBoard.taskBoard.collapseColumnAriaLabel", {
                  lane: label,
                })}
                onClick={onToggleCollapsed}
                className={LANE_ACTION}
              >
                <Minimize2 size={15} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {t("taskBoard.taskBoard.collapseColumn")}
            </TooltipContent>
          </Tooltip>
        </div>
        {announce && (
          <div
            role="status"
            className="mx-1 mb-1.5 flex items-center gap-2 rounded-lg border border-special/30 bg-background px-3 py-2 text-xs text-special"
          >
            <Stars02 size={14} className="shrink-0" />
            <span>
              {t(
                draggedCount > 1
                  ? "taskBoard.dropHint.pickUpMany"
                  : "taskBoard.dropHint.pickUp",
                {
                  names: takers.join(", "),
                },
              )}
            </span>
          </div>
        )}
      </div>
      {swimlanes ? (
        <>
          {anyCritical ? (
            /* Done and Archived keep the row, so the wells below stay aligned. */
            <div
              className={cn(
                "flex min-h-0 min-w-0 flex-col gap-3 px-1 pt-4.5",
                !criticalWell && "invisible",
              )}
            >
              <SwimlaneLabel
                visible={labelled}
                icon={AlertOctagon}
                iconClassName="text-destructive"
                label={t("taskBoard.taskBoard.swimlaneCritical")}
              />
              <div
                ref={setCriticalRef}
                data-lane-scroll={criticalWell ? status : undefined}
                className={SWIMLANE_PANEL}
              >
                <SortableContext
                  items={critical.map((item) => item.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {critical.map(renderCard)}
                </SortableContext>
              </div>
            </div>
          ) : (
            // Holds the empty Critical row so Improvements keeps the 1fr row.
            <div />
          )}
          <div
            className={cn(
              "flex min-h-0 min-w-0 flex-col gap-3 px-1 pb-1",
              anyCritical ? "pt-7" : "pt-4.5",
            )}
          >
            <SwimlaneLabel
              visible={labelled}
              icon={Stars02}
              iconClassName="text-muted-foreground"
              label={t("taskBoard.taskBoard.swimlaneImprovements")}
            />
            <div
              ref={setNodeRef}
              data-lane-scroll={status}
              className={cn(SWIMLANE_PANEL, "pb-16")}
            >
              <SortableContext
                items={rest.map((item) => item.id)}
                strategy={verticalListSortingStrategy}
              >
                {rest.map(renderCard)}
              </SortableContext>
            </div>
          </div>
        </>
      ) : (
        /* px-1 so each card's shadow has room inside the scrollport — an
           overflow-y container clips the x-axis too, which would clip a FLIP-
           animated card mid-flight between lanes (see `use-flip-lanes`,
           keyed off `data-lane-scroll`). */
        <div
          ref={setNodeRef}
          data-lane-scroll={status}
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-1 pt-1 pb-16 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1"
        >
          <SortableContext
            items={items.map((item) => item.id)}
            strategy={verticalListSortingStrategy}
          >
            {items.map(renderCard)}
          </SortableContext>
        </div>
      )}
      <ColumnRulesSheet
        columnKey={status}
        label={label}
        open={rulesOpen}
        onOpenChange={setRulesOpen}
      />
    </div>
  );
}

/** The tinted well a swimlane's cards sit in; it fills its row so wells align. */
const SWIMLANE_PANEL = "flex flex-1 flex-col gap-3 rounded-xl bg-muted/50 p-2";

/** `6m`, `2h`: elapsed, not a clock time. Read at render; it does not tick. */
function elapsed(startedAt: string): string {
  const at = Date.parse(startedAt);
  if (Number.isNaN(at)) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** How many agent runs are live on the board, opening onto the runs and their
 *  cards; absent when none are. */
function AgentsRunningBadge({
  items,
  onOpen,
}: {
  items: TaskBoardItem[];
  onOpen: (item: TaskBoardItem) => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const [open, setOpen] = useState(false);
  const runs = runningAgents(items);
  if (runs.length === 0) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Badge asChild variant="brand" size="control">
          <button type="button">
            <SuperAgentIcon size={18} />
            {runs.length === 1
              ? t("taskBoard.taskBoard.agentsRunningOne")
              : t("taskBoard.taskBoard.agentsRunningMany", {
                  count: runs.length,
                })}
          </button>
        </Badge>
      </PopoverTrigger>
      <PopoverContent
        className="w-[400px] p-0"
        align="end"
        side="bottom"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex items-center gap-2 px-4 pt-3.5 pb-1.5">
          <span className="text-sm font-medium text-foreground">
            {t("taskBoard.taskBoard.agentsRunningHeading")}
          </span>
          <span className="text-sm tabular-nums text-muted-foreground">
            {runs.length}
          </span>
        </div>
        <div className="flex max-h-[420px] flex-col overflow-y-auto p-1.5">
          {runs.map((run) => {
            const item = items.find((i) => i.id === run.taskId);
            if (!item) return null;
            const { label, visual } = laneHeader(item.status, t);
            const LaneIcon = visual.icon;
            return (
              <button
                key={run.threadId}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onOpen(item);
                }}
                className="flex w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2.5 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
              >
                <Spinner className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium text-foreground">
                    {run.runTitle ?? run.taskTitle}
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <LaneIcon
                      size={13}
                      className={cn("shrink-0", visual.iconClassName)}
                    />
                    <span className="shrink-0">{label}</span>
                    <span aria-hidden>·</span>
                    <span className="truncate">
                      {run.runTitle && run.runTitle !== run.taskTitle
                        ? run.taskTitle
                        : taskKey(org.slug, item.keySeq)}
                    </span>
                  </span>
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {elapsed(run.startedAt)}
                </span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** A swimlane's name. Every lane renders it so the rows keep one height; only
 *  the first expanded lane shows it. */
function SwimlaneLabel({
  visible,
  icon: Icon,
  iconClassName,
  label,
}: {
  visible: boolean;
  icon: typeof Stars02;
  iconClassName: string;
  label: string;
}) {
  return (
    <span
      aria-hidden={!visible || undefined}
      className={cn(
        "flex items-center gap-2 px-1 py-0.5 text-sm font-medium text-muted-foreground",
        !visible && "invisible",
      )}
    >
      <Icon size={15} className={cn("shrink-0", iconClassName)} />
      {label}
    </span>
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
  const isEpic = !!useEpicBoard() && item.isEpic;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: item.id,
    // An epic's lane is its cards' to decide, so it never moves by hand.
    disabled: isEpic,
  });

  return (
    // FLIP (see `use-flip-lanes`) owns this wrapper's `transform`/`transition`
    // imperatively, outside React — it needs an element React never re-styles
    // itself, since dnd-kit's own transform/transition below is applied to the
    // card and gets reset on every render, which would cancel FLIP's animation
    // as soon as any unrelated re-render landed mid-flight.
    <TaskContextMenu item={item}>
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
            // The dragged card and its group leave a gap, not a ghost.
            opacity: isDragging || hidden ? 0 : undefined,
          }}
        />
      </div>
    </TaskContextMenu>
  );
}

/**
 * A card's right-click menu. The card is a button, not a link, so the
 * browser's own "Open link in new tab" never appears on it. The URL is the one
 * `openTask` navigates to, so the new tab keeps this board's scope and filters.
 */
function TaskContextMenu({
  item,
  children,
}: {
  item: TaskBoardItem;
  children: ReactNode;
}) {
  const t = useT();
  const router = useRouter();
  const { org } = useProjectContext();
  const openInNewTab = () => {
    const { href } = router.buildLocation({
      to: ".",
      params: (prev: Record<string, unknown>) => ({
        ...prev,
        taskKey: taskRouteSegment(org.slug, item),
      }),
      search: (prev: Record<string, unknown>) => prev,
    });
    window.open(href, "_blank", "noopener");
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={openInNewTab}>
          <LinkExternal01 />
          {t("taskBoard.taskBoard.openInNewTab")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
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
  const checks = useCardChecks(item);
  const epicBoard = useEpicBoard();
  const inHierarchy =
    !!epicBoard &&
    (item.isEpic ||
      !!item.parentId ||
      epicBoard.items.some((other) => other.parentId === item.id));
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

  const action = showAutoFix
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
      : null;

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
        "group relative flex shrink-0 cursor-grab flex-col gap-3 rounded-xl px-3.5 pt-3.5 pb-2.5 text-left shadow-edge active:cursor-grabbing",
        selected
          ? "bg-accent hover:bg-secondary-hover"
          : attentionLabel
            ? "bg-warning/10 hover:bg-warning/15"
            : "bg-card surface-interactive",
        // A dead run outranks a question: both want a person, but only one is already broken.
        runState === "failed"
          ? "shadow-edge-destructive"
          : attentionLabel && "shadow-edge-warning",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        {/* 14px: one step over the design system's `text-sm`, which is 13 here, not Tailwind's 14. */}
        <div className="relative min-w-0 flex-1 text-[14px] font-[450] leading-snug">
          <span
            className={cn(
              "block text-foreground line-clamp-2 wrap-anywhere",
              action && "group-hover:fade-text-end",
            )}
          >
            {item.title}
          </span>
          {action && <CardAction action={action} />}
        </div>
        {attentionLabel && <span className="sr-only">{attentionLabel}</span>}
        {runState && <AgentRunIndicator state={runState} />}
      </div>

      {(item.tags.length > 0 || item.sprintId || inHierarchy) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <EpicProgressPill item={item} />
          <EpicPill item={item} />
          <SubtaskPill item={item} />
          <SprintPill sprintId={item.sprintId} />
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
      />
    </button>
  );
}

/**
 * The badge on a post's author line. `namesLane` marks a badge derived FROM the
 * lane, so the footer chip does not print the same lane twice.
 *
 * Only what someone must act on is coloured, and `created`/`updated` get no
 * badge at all — the timestamp beside them already says it.
 */
const FEED_EVENT_CONFIG: Partial<
  Record<
    FeedEventKind,
    { labelKey: TranslationKey; badgeClassName: string; namesLane?: boolean }
  >
> = {
  blocked: {
    labelKey: "taskBoard.feed.eventBlocked",
    badgeClassName: "border-warning/40 text-warning",
  },
  handed: {
    labelKey: "taskBoard.feed.eventHanded",
    badgeClassName: "border-warning/40 text-warning",
  },
  running: {
    labelKey: "taskBoard.feed.eventRunning",
    badgeClassName: "border-primary/40 text-primary",
  },
  failed: {
    labelKey: "taskBoard.feed.eventFailed",
    badgeClassName: "border-destructive/40 text-destructive",
  },
  done: {
    labelKey: "taskBoard.feed.eventDone",
    badgeClassName: "border-success/40 text-success",
    namesLane: true,
  },
  delivered: {
    labelKey: "taskBoard.feed.eventDelivered",
    badgeClassName: "border-success/40 text-success",
  },
  review: {
    labelKey: "taskBoard.feed.eventReview",
    badgeClassName: "border-border text-muted-foreground",
    namesLane: true,
  },
};

const FEED_TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});

const FEED_DAY_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "short",
  day: "numeric",
});

/**
 * One post in the feed: a message in a thread, not a card in a grid.
 *
 * The body is the newest live run's last message, falling back to the
 * description for a card no agent has touched. The footer claims only facts
 * this board holds — there is no comment count to show.
 */
function FeedRow({
  item,
  bucket,
  author,
  assignee,
  onOpen,
}: {
  item: TaskBoardItem;
  bucket: ProjectIndexEntry | null;
  /** Who last moved this card, when that resolves to a member of the org. */
  author?: Member;
  assignee?: Member;
  onOpen: () => void;
}) {
  const t = useT();
  const event = FEED_EVENT_CONFIG[feedEventKind(item)];
  const lane = laneHeader(item.status, t);
  const LaneIcon = lane.visual.icon;
  const body =
    item.threads.filter(isLiveAttempt)[0]?.lastMessage ?? item.description;
  /** Falls back to the ASSIGNEE: a run writes the row under an id no member
   *  list resolves, and a post signed by nobody reads as unmade. */
  const byAgent = !author && item.assigneeId === SUPER_AGENT_ASSIGNEE_ID;
  const name = byAgent
    ? t("taskBoard.taskDialog.superAgentLabel")
    : (author?.user?.name ?? assignee?.user?.name);
  const cost = summarizeTaskCost(item.threads);
  const checks = useCardChecks(item);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="surface surface-interactive flex w-full flex-col gap-3 p-4 text-left"
    >
      {/* Badges first, Discord-style: what kind of post this is, before what
          it says. */}
      {(item.tags.length > 0 || event) && (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          {event && (
            <span className={cn(PILL, "shrink-0", event.badgeClassName)}>
              {t(event.labelKey)}
            </span>
          )}
          {item.tags.slice(0, CARD_TAG_LIMIT).map((tag) => (
            <TagPill key={tag.id} tag={tag} />
          ))}
          {item.tags.length > CARD_TAG_LIMIT && (
            <span className={PILL}>+{item.tags.length - CARD_TAG_LIMIT}</span>
          )}
        </span>
      )}

      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-base leading-snug font-medium text-foreground">
          {item.title}
        </span>
        {/* Discord's one-liner: who said it and what, truncated to a single
            line rather than clamped to two — a preview, not a second body. */}
        {body && (
          <span className="truncate text-sm leading-relaxed text-muted-foreground">
            {name && (
              <span className="font-medium text-foreground">{name}: </span>
            )}
            {body}
          </span>
        )}
      </span>

      <CardFooter
        item={item}
        checks={checks}
        assignee={assignee}
        trailing={
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {FEED_TIME_FMT.format(new Date(item.updatedAt))}
          </span>
        }
        leading={
          <>
            {bucket && (
              <span className={cn(META, "text-foreground")}>
                <ProjectEntryIcon entry={bucket} />
                {bucket.title}
              </span>
            )}
            {!event?.namesLane && (
              <span className={META}>
                <LaneIcon
                  size={FOOTER_GLYPH}
                  className={lane.visual.iconClassName}
                />
                {lane.label}
              </span>
            )}
            {cost && (
              <span
                className={cn(META, "tabular-nums")}
                title={t(
                  cost.runCount === 1
                    ? "taskBoard.taskDialog.costTooltipSingular"
                    : "taskBoard.taskDialog.costTooltipPlural",
                  { runs: String(cost.runCount) },
                )}
              >
                {cost.total.toLocaleString(undefined, {
                  style: "currency",
                  currency: "USD",
                })}
              </span>
            )}
          </>
        }
      />
    </button>
  );
}

/** What the composer needs; everything else takes its default and is edited
 *  on the card itself. */
export interface FeedComposeInput {
  title: string;
  description: string;
  status: TaskBoardItemStatus;
  priority: TaskBoardItemPriority;
  type: TaskBoardItemType;
}

/**
 * The feed's reply box: title, optional description, and the three properties
 * worth setting before a first read. It creates into the scope the feed is
 * showing, so a card typed inside a project belongs to it.
 */
function FeedComposer({
  onCreated,
}: {
  onCreated: (input: FeedComposeInput) => void;
}) {
  const t = useT();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<TaskBoardItemStatus>(
    CANONICAL_COLUMN_KEYS[0],
  );
  const [priority, setPriority] = useState<TaskBoardItemPriority>("medium");
  const [type, setType] = useState<TaskBoardItemType>(DEFAULT_TASK_TYPE);
  /** State rather than `:focus-within`: picking a property moves focus into a
   *  portaled menu, and collapsing then would shift the row it hangs from. */
  const [engaged, setEngaged] = useState(false);
  const trimmed = title.trim();

  const submit = () => {
    if (!trimmed) return;
    onCreated({
      title: trimmed,
      description: description.trim(),
      status,
      priority,
      type,
    });
    setTitle("");
    setDescription("");
    setStatus(CANONICAL_COLUMN_KEYS[0]);
    setPriority("medium");
    setType(DEFAULT_TASK_TYPE);
    setEngaged(false);
  };

  const statusHeader = laneHeader(status, t);
  const StatusIcon = statusHeader.visual.icon;
  const priorityConfig = PRIORITY_CONFIG[priority];
  const PriorityIconGlyph = priorityConfig.icon;
  const typeConfig = TASK_TYPE_CONFIG[type];
  const TypeIconGlyph = typeConfig.icon;

  return (
    <div className="surface focus-within-ring flex flex-col">
      <div className="flex flex-col gap-1 px-4 pt-4 pb-4">
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onFocus={() => setEngaged(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={t("taskBoard.feed.composerPlaceholder")}
          className="w-full bg-transparent text-base font-medium text-foreground outline-none placeholder:text-muted-foreground"
        />
        {(engaged || description) && (
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={2}
            placeholder={t("taskBoard.feed.composerDescriptionPlaceholder")}
            className="w-full resize-none bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <StatusIcon
                  size={14}
                  className={statusHeader.visual.iconClassName}
                />
                {statusHeader.label}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-44">
              {CANONICAL_COLUMN_KEYS.map((s) => {
                const { label, visual } = laneHeader(s, t);
                const Icon = visual.icon;
                return (
                  <DropdownMenuItem
                    key={s}
                    onSelect={() => setStatus(s)}
                    className="gap-2"
                  >
                    <Icon size={16} className={visual.iconClassName} />
                    {label}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <TypeIconGlyph size={14} className={typeConfig.iconClassName} />
                {t(typeConfig.labelKey)}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-44">
              {TASK_TYPES.map((tp) => {
                const Icon = TASK_TYPE_CONFIG[tp].icon;
                return (
                  <DropdownMenuItem
                    key={tp}
                    onSelect={() => setType(tp)}
                    className="gap-2"
                  >
                    <Icon
                      size={16}
                      className={TASK_TYPE_CONFIG[tp].iconClassName}
                    />
                    {t(TASK_TYPE_CONFIG[tp].labelKey)}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <PriorityIconGlyph
                  size={14}
                  className={priorityConfig.iconClassName}
                />
                {t(priorityConfig.labelKey)}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-40">
              {PRIORITIES.map((p) => {
                const Icon = PRIORITY_CONFIG[p].icon;
                return (
                  <DropdownMenuItem
                    key={p}
                    onSelect={() => setPriority(p)}
                    className="gap-2"
                  >
                    <Icon
                      size={16}
                      className={PRIORITY_CONFIG[p].iconClassName}
                    />
                    {t(PRIORITY_CONFIG[p].labelKey)}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <Button size="sm" disabled={!trimmed} onClick={submit}>
          {t("taskBoard.feed.composerSubmit")}
        </Button>
      </div>
    </div>
  );
}

/** Every visible card, newest first, under the day it last moved on. `now` is
 *  read once per render so rows cannot disagree across midnight. */
function FeedView({
  items,
  index,
  memberByUserId,
  onCompose,
  onOpen,
}: {
  items: TaskBoardItem[];
  index: ProjectIndex;
  memberByUserId: Map<string, Member>;
  onCompose: (input: FeedComposeInput) => void;
  onOpen: (item: TaskBoardItem) => void;
}) {
  const t = useT();
  const now = new Date();
  const days = groupFeedByDay(items, now);

  return (
    /* Composer and rail sit OUTSIDE the scrolling region; only posts scroll. */
    <div className="flex min-h-0 flex-1 flex-col px-4 pt-6 sm:px-8">
      <div className="mx-auto flex min-h-0 w-full max-w-[760px] flex-1 flex-col gap-6">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <FeedComposer onCreated={onCompose} />
          {/* A post leaving the top dissolves rather than being cut: the first
              `FEED_FADE` of the scroller is masked out, the day header sticks
              just below that band, and the same distance of padding keeps the
              newest post clear of it at rest. The horizontal `px-2 -mx-2` is
              room for the cards' shadow, which an `overflow` box clips. */}
          <div className="min-h-0 flex-1 overflow-y-auto -mx-2 px-2 pt-5 pb-16 [mask-image:linear-gradient(to_bottom,transparent,#000_20px)]">
            {days.map((day) => (
              <section key={day.key} className="flex flex-col">
                {/* Not sticky. Pinned, it ended up sitting ON a post — over an
                    avatar and half a name — which reads as a rendering bug, and
                    no label is worth that. The posts under one heading are few
                    enough that scrolling past it is the whole cost. */}
                <h2 className="mt-3 mb-4 px-1 text-xs font-medium text-muted-foreground">
                  {day.relative === "today"
                    ? t("taskBoard.feed.today")
                    : day.relative === "yesterday"
                      ? t("taskBoard.feed.yesterday")
                      : FEED_DAY_FMT.format(day.date)}
                </h2>
                <div className="flex flex-col gap-2">
                  {day.items.map((item) => (
                    <FeedRow
                      key={item.id}
                      item={item}
                      bucket={entryForTask(item, index)}
                      assignee={
                        item.assigneeId
                          ? memberByUserId.get(item.assigneeId)
                          : undefined
                      }
                      author={memberByUserId.get(item.updatedBy)}
                      onOpen={() => onOpen(item)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** One row, one line: priority, key, title, then labels, assignee and age in
 *  fixed slots so a column of rows aligns. */
type GroupHeadingContext = {
  memberByUserId: Map<string, Member>;
  orgTags: OrgTag[];
  index: ProjectIndex;
};

/** The list view's collapsible groups; contents hang off a guide line. */
function ListGroupTree({
  groups,
  depth,
  toggled,
  onToggle,
  renderRow,
  heading,
}: {
  groups: ListGroup[];
  depth: number;
  toggled: ReadonlyMap<string, boolean>;
  onToggle: (group: ListGroup, siblings: ListGroup[], all: boolean) => void;
  renderRow: (item: TaskBoardItem) => ReactNode;
  heading: GroupHeadingContext;
}) {
  const t = useT();
  return groups.map((group) => {
    const open = isGroupOpen(group, toggled);
    const { glyph, label } = listGroupHeading(group, { ...heading, t });
    return (
      <section
        key={group.path}
        data-list-group={group.path}
        className="flex flex-col gap-2"
      >
        <Tooltip delayDuration={600}>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-expanded={open}
              onClick={(event) => onToggle(group, groups, event.altKey)}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium text-foreground transition-colors",
                depth === 0
                  ? "bg-muted/60 hover:bg-accent"
                  : "bg-muted/30 hover:bg-accent",
              )}
            >
              <ChevronRight
                size={14}
                className={cn(
                  "shrink-0 text-muted-foreground transition-transform",
                  open && "rotate-90",
                )}
              />
              <span className="flex size-4 shrink-0 items-center justify-center">
                {glyph}
              </span>
              <span className="truncate">{label}</span>
              <span className="text-muted-foreground">
                {group.items.length}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" align="start">
            {t("taskBoard.viewControls.groupToggleAllHint")}
          </TooltipContent>
        </Tooltip>
        {open && (
          // The guide sits under the header's chevron (px-3 + half its 14px).
          <div className="ml-[18px] flex flex-col gap-2 border-l-[1.5px] border-muted-foreground/30 pl-3">
            {group.children ? (
              <ListGroupTree
                groups={group.children}
                depth={depth + 1}
                toggled={toggled}
                onToggle={onToggle}
                renderRow={renderRow}
                heading={heading}
              />
            ) : (
              group.items.map(renderRow)
            )}
          </div>
        )}
      </section>
    );
  });
}

function listGroupHeading(
  group: ListGroup,
  {
    memberByUserId,
    orgTags,
    index,
    t,
  }: GroupHeadingContext & { t: ReturnType<typeof useT> },
): { glyph: ReactNode; label: string } {
  const { key, groupBy } = group;
  switch (groupBy) {
    case "status": {
      const { label, visual } = laneHeader(key, t);
      const Icon = visual.icon;
      return {
        glyph: (
          <Icon size={15} className={cn("shrink-0", visual.iconClassName)} />
        ),
        label,
      };
    }
    case "priority": {
      const priority = PRIORITIES.find((p) => p === key);
      if (!priority) return { glyph: null, label: key };
      const config = PRIORITY_CONFIG[priority];
      const Icon = config.icon;
      return {
        glyph: (
          <Icon size={15} className={cn("shrink-0", config.iconClassName)} />
        ),
        label: t(config.labelKey),
      };
    }
    case "assignee": {
      if (key === SUPER_AGENT_ASSIGNEE_ID) {
        return {
          glyph: <SuperAgentIcon size={16} />,
          label: t("taskBoard.taskFilters.assigneeSuperAgent"),
        };
      }
      if (key === UNASSIGNED_FILTER) {
        return {
          glyph: (
            <User01 size={15} className="shrink-0 text-muted-foreground" />
          ),
          label: t("taskBoard.taskFilters.assigneeUnassigned"),
        };
      }
      const member = memberByUserId.get(key);
      return {
        glyph: (
          <Avatar
            url={member?.user?.image ?? undefined}
            fallback={member?.user?.name ?? "?"}
            shape="circle"
            size="2xs"
          />
        ),
        label: member?.user?.name ?? t("taskBoard.taskFilters.assigneeMember"),
      };
    }
    case "tags": {
      if (key === NO_TAG_GROUP) {
        return {
          glyph: (
            <span className="size-2 shrink-0 rounded-full border border-muted-foreground/50" />
          ),
          label: t("taskBoard.viewControls.groupNoTags"),
        };
      }
      const tag =
        orgTags.find((candidate) => candidate.id === key) ??
        group.items[0]?.tags.find((candidate) => candidate.id === key);
      return {
        glyph: (
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: tagDotColor(tag?.color) }}
          />
        ),
        label: tag?.name ?? key,
      };
    }
    case "project": {
      if (key === NO_PROJECT_FILTER) {
        return {
          glyph: <ProjectEntryIcon entry={undefined} />,
          label: t("taskBoard.taskFilters.projectNone"),
        };
      }
      const entry = entryForFilter(key, index);
      return {
        glyph: <ProjectEntryIcon entry={entry} />,
        label: entry?.title ?? key,
      };
    }
    default: {
      const exhaustive: never = groupBy;
      return exhaustive;
    }
  }
}

/** The row's status icon, which opens the statuses the task can move to. */
function ListRowStatusMenu({
  item,
  onStatusChange,
}: {
  item: TaskBoardItem;
  onStatusChange: (status: TaskBoardItemStatus) => void;
}) {
  const t = useT();
  const StatusIcon = laneVisual(item.status).icon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("taskBoard.taskBoard.changeStatusLabel", {
            status: laneHeader(item.status, t).label,
          })}
          className="shrink-0 rounded-md p-1 transition-colors hover:bg-accent"
        >
          <StatusIcon size={16} className={cn(statusIconClassName(item))} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        {CANONICAL_COLUMN_KEYS.map((status) => {
          const { label, visual } = laneHeader(status, t);
          const Icon = visual.icon;
          return (
            <DropdownMenuItem
              key={status}
              className="gap-2"
              onSelect={() => {
                if (status !== item.status) onStatusChange(status);
              }}
            >
              <Icon size={16} className={visual.iconClassName} />
              {label}
              {status === item.status && (
                <Check size={14} className="ml-auto shrink-0" />
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Longer than a deliberate double-click, shorter than a noticeable wait. */
const DOUBLE_CLICK_MS = 250;

/**
 * The row's title: a click opens the task, a double-click renames it in place.
 *
 * A mouse click waits out {@link DOUBLE_CLICK_MS} before opening — the task
 * takes the page over, so opening on the first click would leave the second
 * nothing to land on. Keyboard activation (`detail` 0) opens at once.
 */
function ListRowTitle({
  title,
  onOpen,
  onRename,
}: {
  title: string;
  onOpen: () => void;
  onRename: (title: string) => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  if (editing) {
    return (
      <input
        autoFocus
        defaultValue={title}
        aria-label={t("taskBoard.taskBoard.renameTaskLabel")}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => {
          setEditing(false);
          const next = e.currentTarget.value.trim();
          if (next && next !== title) onRename(next);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            e.stopPropagation();
            e.currentTarget.value = title;
            e.currentTarget.blur();
          }
        }}
        className="min-w-0 flex-1 rounded-sm bg-transparent text-sm text-foreground outline-none ring-1 ring-ring"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        clearTimeout(openTimer.current);
        if (e.detail === 0) onOpen();
        else if (e.detail === 1)
          openTimer.current = setTimeout(onOpen, DOUBLE_CLICK_MS);
      }}
      onDoubleClick={() => {
        clearTimeout(openTimer.current);
        setEditing(true);
      }}
      className="min-w-0 flex-1 truncate text-left text-sm text-foreground"
    >
      {title}
    </button>
  );
}

/** The row's tags, and the picker that edits them. */
function ListRowTags({
  tags,
  onChange,
}: {
  tags: TaskBoardItemTag[];
  onChange: (tagIds: string[]) => void;
}) {
  const t = useT();
  const { data: orgTags = [] } = useTags();
  const createTag = useCreateTag();
  const deleteTag = useDeleteTag();
  const tagIds = tags.map((tag) => tag.id);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("taskBoard.taskBoard.editTagsLabel")}
          title={t("taskBoard.taskBoard.editTagsLabel")}
          className={cn(
            "hidden shrink-0 items-center gap-1.5 rounded-full sm:inline-flex",
            tags.length === 0 && HOVER_ONLY,
          )}
        >
          {tags.length === 0 ? (
            <span className={PILL}>
              <Plus size={FOOTER_GLYPH} />
            </span>
          ) : (
            <>
              {tags.slice(0, CARD_TAG_LIMIT).map((tag) => (
                <TagPill key={tag.id} tag={tag} />
              ))}
              {tags.length > CARD_TAG_LIMIT && (
                <span className={PILL}>+{tags.length - CARD_TAG_LIMIT}</span>
              )}
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-0">
        <TagPickerContent
          tags={orgTags}
          selectedIds={tagIds}
          defaultColor={nextTagColor(orgTags.length)}
          onToggle={(tagId) =>
            onChange(
              tagIds.includes(tagId)
                ? tagIds.filter((id) => id !== tagId)
                : [...tagIds, tagId],
            )
          }
          onCreate={async (name, color) => {
            const tag = await createTag.mutateAsync({ name, color });
            onChange([...tagIds, tag.id]);
          }}
          onDelete={(tagId) => {
            deleteTag.mutate(tagId);
            if (tagIds.includes(tagId))
              onChange(tagIds.filter((id) => id !== tagId));
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

function ListRow({
  item,
  assignee,
  assignedBy,
  members,
  onOpen,
  onStatusChange,
  onRename,
  onPriorityChange,
  onTagsChange,
  onDueDateChange,
  onAssign,
}: {
  item: TaskBoardItem;
  assignee?: Member;
  assignedBy?: Member;
  members: Member[];
  onOpen: () => void;
  onStatusChange: (status: TaskBoardItemStatus) => void;
  onRename: (title: string) => void;
  onPriorityChange: (priority: TaskBoardItemPriority) => void;
  onTagsChange: (tagIds: string[]) => void;
  onDueDateChange: (iso: string) => void;
  onAssign: (userId: string | null) => void;
}) {
  const { org } = useProjectContext();
  const key = taskKey(org.slug, item.keySeq);
  const runState = agentRunState(item);
  return (
    <TaskContextMenu item={item}>
      <div className="group flex h-11 items-center gap-3 px-3 transition-colors hover:bg-accent">
        <ListRowStatusMenu item={item} onStatusChange={onStatusChange} />
        <span className="flex size-4 shrink-0 items-center justify-center">
          <PriorityIcon priority={item.priority} onChange={onPriorityChange} />
        </span>
        {key && (
          <span className="hidden w-16 shrink-0 font-mono text-xs text-muted-foreground sm:inline">
            {key}
          </span>
        )}
        <ListRowTitle title={item.title} onOpen={onOpen} onRename={onRename} />
        {runState && <AgentRunIndicator state={runState} />}
        {isTaskBlocked(item) && <BlockedBadge />}
        {isTaskHandedToHuman(item) && <HandedToHumanBadge />}
        {item.sprintId && (
          <span className="hidden sm:inline-flex">
            <SprintPill sprintId={item.sprintId} />
          </span>
        )}
        <ListRowTags tags={item.tags} onChange={onTagsChange} />
        {item.statusSince && (
          <span className="hidden sm:inline-flex">
            <StatusAgePill status={item.status} since={item.statusSince} />
          </span>
        )}
        <span className="hidden sm:inline-flex">
          <FooterDueDate iso={item.dueDate} onChange={onDueDateChange} />
        </span>
        <span className="flex w-5 shrink-0 justify-center">
          <AssigneeDisplay
            item={item}
            assignee={assignee}
            assignedBy={assignedBy}
            members={members}
            onAssign={onAssign}
          />
        </span>
        <span className="hidden w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:inline">
          {formatTimeAgo(new Date(item.createdAt))}
        </span>
      </div>
    </TaskContextMenu>
  );
}
