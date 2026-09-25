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
import { TaskBoardAdminBanner, TaskBoardAdminControls } from "./admin-controls";
import { BoardOrgProvider } from "./board-org";
import { getInitials } from "@/lib/get-initials";
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
  CheckCircle,
  ChevronRight,
  DotsHorizontal,
  HelpCircle,
  Lightning01,
  Plus,
  RefreshCw01,
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
import { ReviewerIcon } from "@/components/reviewer-icon";
import { getWellKnownDecopilotVirtualMCP, useProjectContext } from "@/sdk";

import { RepositoryImportPicker } from "@/components/repository-import-picker";
import { useMembers } from "@/hooks/use-members";
import {
  useTaskBoardItemActions,
  useTaskBoardItems,
} from "@/hooks/use-task-board-items";
import { formatTimeAgo } from "@/lib/format-time";
import {
  agentRunState,
  cardNeedsAttention,
  isLiveAttempt,
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
  dropLane,
  LANE_DROPPABLE_PREFIX,
  laneHeader,
  SUPER_AGENT_ASSIGNEE_ID,
  tagDotColor,
  TASK_TYPES,
  type TaskBoardItem,
  type TaskBoardItemPriority,
  type TaskBoardItemStatus,
  type TaskBoardItemTag,
  type Member,
} from "./config";
import { useTags } from "@/hooks/use-tags";
import {
  useOrgFlag,
  useReviewerEnabled,
} from "@/hooks/use-organization-settings";
import { usePreferences } from "@/hooks/use-preferences";
import {
  TaskBoardItemDetail,
  TaskBoardItemDialog,
  toEndOfDayIso,
} from "./task-dialog";
import { AssigneePickerContent } from "./assignee-picker";
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
  taskMatchesFilters,
  type TaskFilters,
} from "./task-filters-core";
import {
  AppliedFiltersBar,
  BoardSettingsButton,
  TaskFilterButton,
} from "./view-controls";
import { useBoardSearch, visibleSelection } from "./filters-search";
import { feedEventKind, groupFeedByDay, type FeedEventKind } from "./feed";
import { compactElapsed, feedRail } from "./feed-rail";
import { useProjectIndex } from "@/hooks/use-project-index";
import { useProjectScope } from "@/hooks/use-project-scope";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { projectRepo } from "@/lib/github-repo";
import { scopedBoardItems } from "./board-scope";
import {
  entryForFilter,
  entryForTask,
  filterAfterCreate,
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
  useSearch,
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

function formatDueDate(iso: string): { label: string; overdue: boolean } {
  const d = new Date(iso);
  const overdue = d.getTime() < Date.now();
  return { label: DATE_FMT.format(d), overdue };
}

/** Shared meta chip: an outlined pill, neutral border by default. */
const PILL =
  "inline-flex items-center gap-1 rounded-full border-[length:var(--border-hairline)] border-border px-2 py-0.5 text-xs font-medium text-muted-foreground";

/** A fact about a row said in plain text — glyph and word, no chrome. The
 *  bordered {@link PILL} is kept for a tag, whose colour IS its border. */
const META =
  "inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground";

/** A lane's own controls: shown when the pointer is over the lane, or the
 *  control has focus or its menu open. Always-on, every column headline
 *  carried two grey glyphs that said nothing until they were wanted. */
const LANE_ACTION =
  "flex size-6 shrink-0 items-center justify-center rounded-lg text-muted-foreground opacity-0 transition-[color,background-color,opacity] hover:bg-muted hover:text-foreground group-hover/lane:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100";

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
      size="sm"
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
      className="absolute -top-0.5 right-0 h-6 gap-1.5 px-2 text-xs font-medium shadow-sm pointer-events-none opacity-0 transition-opacity focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
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
  /** Facts a board card gets from its surroundings and a feed post cannot:
   *  which project it belongs to, which lane it is in, what it has cost. They
   *  join the left group so the footer keeps ONE baseline on both surfaces. */
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

/** List-row due date. Cards use {@link FooterDueDate} instead. */
function DueDatePill({ iso }: { iso: string }) {
  const { label, overdue } = formatDueDate(iso);
  return (
    <span className={cn(META, overdue && "text-destructive")}>
      <Calendar size={FOOTER_GLYPH} />
      {label}
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
          // Shown on the card's hover: a dashed circle on every unassigned card is a row of holes.
          className="flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed border-muted-foreground/40 text-muted-foreground/40 opacity-0 transition-[color,border-color,opacity] group-hover:opacity-100 hover:border-muted-foreground hover:text-muted-foreground focus-visible:opacity-100 data-[state=open]:opacity-100"
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

/** The board, pointed at whichever org `?boardOrg=` names (normally your own).
 *  The swap has to wrap the board rather than live inside it: every hook below
 *  reads the org off `ProjectContext`. */
export function TaskBoardPage({
  scopeProject,
  inlineTabs = false,
  taskInSearch = false,
}: {
  /** Narrow to this project explicitly, for a mount whose ROUTE carries no
   *  `$agentId` to read the scope from (`/$org/projects?project=`). Omitted on
   *  every other mount, which resolves from the route as before.
   *
   *  Must be the RESOLVED entity. Passing it skips the "scope known, project
   *  not yet" loading branch, so a stub carrying only an id would build an
   *  index with no repository bucket and render an empty board instead of a
   *  loading one. With only an id, pass nothing and let the route answer. */
  scopeProject?: VirtualMCPEntity;
  /** Draw the Board/List/Feed tabs at the top of the board instead of
   *  portalling them into the panel toolbar. For a mount that is only PART of
   *  its page (`/$org/projects?project=`, where a project header and its apps
   *  sit above): a toolbar control belongs to the whole panel, so up there it
   *  reads as switching the screen rather than the board under it.
   *
   *  A placement and not a "render them yourself" escape hatch, deliberately.
   *  Switching to List or Feed has to `clearSelection()` — that only the board
   *  can do, and a second copy of these tabs outside it would drop it. */
  inlineTabs?: boolean;
  /** Address the open card in `?task=` instead of the route's `{-$taskKey}`
   *  segment — for a mount whose route has no such segment to write
   *  (`/$org/projects?project=`, which cannot grow one: one more child route
   *  breaks TanStack's `to: "."` search inference app-wide, as
   *  `projectsIndexRoute` explains). Without it, clicking a card navigated to
   *  a param the route does not own and nothing opened. */
  taskInSearch?: boolean;
} = {}) {
  return (
    <BoardOrgProvider>
      <TaskBoardBody
        scopeProject={scopeProject}
        inlineTabs={inlineTabs}
        taskInSearch={taskInSearch}
      />
    </BoardOrgProvider>
  );
}

function TaskBoardBody({
  scopeProject,
  inlineTabs,
  taskInSearch,
}: {
  scopeProject?: VirtualMCPEntity;
  inlineTabs?: boolean;
  taskInSearch?: boolean;
}) {
  const t = useT();
  const { items: orgItems, isLoading: itemsLoading } = useTaskBoardItems();
  /** A project's home IS this board — see `board-scope.ts` for why scope is a
   *  narrowing of the input rather than a value in the `?repo=` filter. */
  const { scopeId: routeScopeId, project: routeProject } = useProjectScope();
  const scopeId = scopeProject?.id ?? routeScopeId;
  const scopedProject = scopeProject ?? routeProject;
  const { items, isLoading } = scopedBoardItems({
    items: orgItems,
    scopeId,
    project: scopedProject,
    isLoading: itemsLoading,
  });
  const { data: orgTags = [] } = useTags();
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
  const { data: membersData } = useMembers();
  const members = (membersData?.data?.members ?? []) as Member[];
  const memberByUserId = new Map(members.map((m) => [m.userId, m]));

  // Filters + layout live in the URL, so a refresh or a shared link keeps them.
  const { filters, setFilters, layout, setLayout } = useBoardSearch(
    inlineTabs ? "feed" : "board",
  );
  /** The board's buckets, closed over every repo a loaded card names so the
   *  "No project" bucket cannot claim a card that plainly has one. */
  const projectIndex = useProjectIndex(items, repos);
  /** The projects a card can be stamped for — the same reachability-gated
   *  subset the task dialog's Project picker offers, reused by the bulk bar. */
  const projectEntries = stampableEntries(projectIndex);
  /** The repo a new card inherits: the active Project filter's, so a card made
   *  while the board is narrowed to a project belongs to it. Null for a
   *  repo-less project (the card links to it through its thread instead). */
  const activeProjectRepo = filters.project
    ? (entryForFilter(filters.project, projectIndex)?.repo ?? null)
    : null;
  const [preferences] = usePreferences();
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
  const { setTaskId } = usePanelActions();
  const { create } = useThreadActions();
  const studio = useStudioTools();
  const { org, locator } = useProjectContext();
  const navigate = useNavigate();
  /** Scoped to a project, the gear is that project's own settings — the board
   *  behind it has none of its own to open. Only the unscoped, org-wide board
   *  (settings/task-board) has settings of its own to reach. */
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
  const { task: taskKeySearch } = useSearch({ strict: false }) as {
    task?: string;
  };
  const openTaskKey = taskInSearch ? taskKeySearch : taskKeyParam;
  /**
   * Where this mount writes a card's address — the route segment normally, or
   * `?task=` on the one screen that has no segment to write (see
   * `taskInSearch`). Every open, close and canonicalization goes through it,
   * so the two spellings cannot drift apart.
   */
  const taskAddress = (key: string | undefined) =>
    taskInSearch
      ? {
          params: (prev: Record<string, unknown>) => prev,
          search: (prev: Record<string, unknown>) => ({ ...prev, task: key }),
        }
      : {
          params: (prev: Record<string, unknown>) => ({
            ...prev,
            taskKey: key,
          }),
          search: (prev: Record<string, unknown>) => prev,
        };
  /** Resolved against the ORG's cards, not the scoped slice: a card's URL is
   *  its one address, and a link followed from outside the project it belongs
   *  to must open it rather than redirect away as stale. */
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
  // The list view has no "Hidden columns" drawer, so it drops hidden lanes outright.
  const visibleListItems = visibleItems.filter(
    (item) =>
      !HIDDEN_STATUSES.includes(item.status) ||
      preferences.shownTaskBoardLanes.includes(item.status),
  );

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
  const widenProjectFilterFor = (repo: string | null) => {
    const next = filterAfterCreate({ repo }, filters.project, projectIndex);
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

  /** Board / List / Feed. One definition for both placements — see
   *  `inlineTabs`. */
  const layoutTabs = (
    <Page.Tabs>
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
    </Page.Tabs>
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
            {scopeProject?.title ?? t("taskBoard.taskBoard.tasksTitle")}
          </Page.Title>
          <Page.Actions
            secondary={
              items.length > 0 && (
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
                      placeholder={t("taskBoard.taskFilters.searchPlaceholder")}
                      clearLabel={t("taskBoard.taskFilters.searchClearLabel")}
                    />
                    <TaskFilterButton
                      filters={filters}
                      items={items}
                      members={members}
                      tags={orgTags}
                      index={projectIndex}
                      onChange={handleFiltersChange}
                    />
                    <BoardSettingsButton
                      onClick={openBoardSettings}
                      label={boardSettingsLabel}
                    />
                  </div>
                </>
              )
            }
          >
            <TaskBoardAdminControls />
            <Button size="sm" onClick={openCreate}>
              <Plus size={16} />
              {t("taskBoard.taskBoard.newTask")}
            </Button>
          </Page.Actions>
          {inlineTabs ? (
            /* The board's own toolbar strip, fenced off from the apps
                   launcher above it by a full-bleed rule: without one the tabs
                   read as a third row of the project header rather than the
                   control of the region under them. Full-bleed and not capped
                   like the row inside it — a rule that stops short of the panel
                   edge is a box someone forgot to finish. The row is padded for
                   the filters that sit beside these tabs. */
            <div className="mt-2 border-t border-border">
              {/* Same page padding as the project overview header above it (`Page.Container`'s), not the org-wide board's. */}
              <div className="mx-auto w-full max-w-[1680px] px-4 pt-4 pb-3 md:px-8">
                {layoutTabs}
              </div>
            </div>
          ) : (
            <Panel.Toolbar.Left.Portal>{layoutTabs}</Panel.Toolbar.Left.Portal>
          )}
        </>
      )}

      <div
        className={cn(
          "mx-auto w-full max-w-[1680px]",
          inlineTabs ? "px-4 md:px-8" : "px-4 sm:px-8",
        )}
      >
        <TaskBoardAdminBanner />
      </div>
      <AppliedFiltersBar
        filters={filters}
        items={items}
        members={members}
        tags={orgTags}
        index={projectIndex}
        onChange={handleFiltersChange}
      />

      {items.length === 0 ? (
        <div
          className={cn(
            "mx-auto w-full max-w-[1680px]",
            inlineTabs ? "px-4 pt-4 md:px-8" : "px-4 pt-6 sm:px-8",
          )}
        >
          <div className="rounded-xl bg-card px-4 py-12 text-center text-sm text-muted-foreground card-shadow">
            {t("taskBoard.taskBoard.noTasksYet")}
          </div>
        </div>
      ) : visibleItems.length === 0 ? (
        <div
          className={cn(
            "mx-auto w-full max-w-[1680px]",
            inlineTabs ? "px-4 pt-4 md:px-8" : "px-4 pt-6 sm:px-8",
          )}
        >
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
      ) : layout === "feed" ? (
        <FeedView
          items={visibleListItems}
          index={projectIndex}
          memberByUserId={memberByUserId}
          onCompose={(input) =>
            actions.create.mutate({
              ...input,
              repo: scopedProject ? projectRepo(scopedProject) : undefined,
            })
          }
          onOpen={openTask}
          project={inlineTabs ? (scopedProject ?? undefined) : undefined}
        />
      ) : layout === "board" ? (
        <Lanes
          visible={!openItem}
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
          inlineTabs={inlineTabs}
        />
      ) : (
        <ListView
          items={visibleListItems}
          memberByUserId={memberByUserId}
          onOpen={openTask}
          inlineTabs={inlineTabs}
        />
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
              dueDate: openItem.dueDate,
              tagIds: openItem.tags.map((tag) => tag.id),
            });
            widenProjectFilterFor(openItem.repo ?? null);
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
        defaultRepo={activeProjectRepo}
        isSaving={actions.create.isPending}
        onSubmit={(input) => {
          if (blockSuperAgentWithoutRepository(input.assigneeId)) {
            closeCreate();
            return;
          }
          actions.create.mutate(input);
          widenProjectFilterFor(input.repo ?? null);
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
          onSetRepo={(repo) => {
            for (const id of selectedIds) actions.update.mutate({ id, repo });
            clearSelection();
          }}
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
  onSetRepo,
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
  /** The projects a card can be stamped for — same set as the task dialog. */
  projectEntries: ProjectIndexEntry[];
  /** Bulk-assign the project (persisted as the underlying repo), or clear it. */
  onSetRepo: (repo: string | null) => void;
  onMoveTo: (status: TaskBoardItemStatus) => void;
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
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
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
                {moveTargets(deliveryEnabled).map((status) => (
                  <DropdownMenuItem
                    key={status}
                    onClick={() => onMoveTo(status)}
                  >
                    {laneHeader(status, t).label}
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
            {projectEntries.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  {t("taskBoard.taskBoard.assignProjectButton")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-64">
                  <DropdownMenuItem onClick={() => onSetRepo(null)}>
                    {t("taskBoard.taskDialog.noProject")}
                  </DropdownMenuItem>
                  {projectEntries.map((entry) => (
                    <DropdownMenuItem
                      key={entry.id}
                      className="gap-2"
                      onClick={() => onSetRepo(entry.repo)}
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
          <button
            type="button"
            onClick={onAutoFix}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            <Lightning01 size={14} />
            {t("taskBoard.taskBoard.autoFix")}
          </button>
        )}

        {onRerun && (
          <button
            type="button"
            onClick={onRerun}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
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
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

/** Where a card sits locally: while a drag is in flight, and then until the
 *  server's optimistic patch catches up. */
interface Placement {
  status: TaskBoardItemStatus;
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
  inlineTabs,
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
  ) => void;
  onAutoFix?: (item: TaskBoardItem) => void;
  onRerun?: (item: TaskBoardItem) => void;
  onAssign?: (id: string, userId: string | null) => void;
  onPriorityChange?: (id: string, priority: TaskBoardItemPriority) => void;
  onTypeChange?: (id: string, type: TaskBoardItemType) => void;
  onDueDateChange?: (id: string, iso: string) => void;
  /** False while the task detail has the panel — see `useFlipLanes`. */
  visible: boolean;
  /** See `TaskBoardPage`'s own doc comment. */
  inlineTabs?: boolean;
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
  } = laneVisibility({
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

  const place = (ids: string[], status: TaskBoardItemStatus, slot: number) => {
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
        {/* The lanes SHARE the width instead of each taking a fixed 300px:
            `minmax(280px, 1fr)` fills the panel when there is room and falls
            back to scrolling once every lane is at its minimum. Fixed columns
            left a dead margin on a wide screen and made the board scroll
            sideways at widths where it did not have to. Inline, because the
            track count is the lane count. 280px, not less — below it a card's
            footer (type + key, due date, priority, checks, assignee) runs out
            of room and its icons start overlapping instead of wrapping. */}
        <div
          className={cn(
            "mx-auto grid h-full w-full max-w-[1680px] gap-3",
            inlineTabs ? "px-4 pt-4 md:px-8" : "px-4 pt-6 sm:px-8",
          )}
          style={{
            gridTemplateColumns: `repeat(${boardLanes.length}, minmax(280px, 1fr))`,
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
              countOf={(status) => laneItems(status).length}
              onShow={(status) => setLaneShown(status, true)}
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
  countOf,
  onShow,
}: {
  statuses: string[];
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
          const { label, visual } = laneHeader(status, t);
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
                    className="flex size-6 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
  status: TaskBoardItemStatus;
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
  onCreate: (status: TaskBoardItemStatus) => void;
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
  const { label, visual } = laneHeader(status, t);
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
        "group/lane flex h-full min-w-0 flex-col rounded-xl py-1 transition-colors",
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
        <DropdownMenu>
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
        <button
          type="button"
          aria-label={t("taskBoard.taskBoard.newTaskInLaneAriaLabel", {
            lane: label,
          })}
          title={t("taskBoard.taskBoard.newTaskInLaneTitle", { lane: label })}
          onClick={() => onCreate(status)}
          className={LANE_ACTION}
        >
          <Plus size={15} />
        </button>
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
        <div className="relative min-w-0 flex-1 text-[14px] font-[450] leading-snug">
          <span
            className={cn(
              "block text-foreground line-clamp-2",
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

      {item.tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
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
 * How each feed event reads: the badge pinned to the right of a post's author
 * line, saying what the news is.
 *
 * `namesLane` is the one non-obvious field: a badge derived FROM the lane
 * ("Shipped" is `done`, "In review" is `in_review`) would otherwise print its
 * own lane a second time as a chip in the footer. Every other event — a run, a
 * hand-off, a plain edit — leaves the lane unsaid, so the chip is the only
 * place it appears.
 *
 * Only what someone has to act on is coloured, and only an event that IS news
 * gets a badge at all: `created` and `updated` have no entry here, because a
 * badge on nearly every post said no more than the timestamp beside it while
 * making a red "Run failed" one more pill in a row of them.
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
 * One post in the feed: who, when, what it is about, and what they said.
 *
 * A message in a thread, not a card in a grid — no border, no shadow, just a
 * divider between one post and the next. Every card on this board already has
 * an author (a person, or the agent that ran on it) and a body (the run's own
 * last words), so it reads as a conversation the board has been having, and
 * the card container was furniture around a sentence.
 *
 * The body is the newest live run's last message when there is one, and the
 * description otherwise — an agent's own account of what it just did is the
 * point of reading a feed, and a description that never changes is only a
 * fallback for a card no agent has touched.
 *
 * Only facts this board holds appear in the footer. There is no comment count
 * and no per-run reply thread to read, so neither is claimed.
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
  /** The author falls back to the ASSIGNEE, which is the one slot that can hold
   *  the agent: a run writes the row under an id no member list resolves, and
   *  a post signed by nobody reads as a post nobody made. */
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
      className="flex w-full flex-col gap-3 rounded-[var(--studio-surface-radius,var(--radius-xl))] bg-card p-4 text-left card-shadow transition-colors hover:bg-accent/60"
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
        <span className="text-[15px] leading-snug font-medium text-foreground">
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

/** What starting a card from the feed's composer needs — the rest of a card
 *  (labels, due date, assignee, project) takes its default and is edited on
 *  the card itself, which is where someone is looking when it matters. */
export interface FeedComposeInput {
  title: string;
  description: string;
  status: TaskBoardItemStatus;
  priority: TaskBoardItemPriority;
  type: TaskBoardItemType;
}

/**
 * The card at the top of the feed that starts a card.
 *
 * A feed you only read is a log. This is the reply box — title, an optional
 * description, and the three properties worth setting before a first read
 * (status, type, priority) rather than after. Everything else about the card
 * (labels, due date, assignee, project) takes its default and is edited on
 * the card itself, which is where someone is looking when it matters.
 *
 * It creates into the scope the feed is already showing, so a card typed inside
 * a project belongs to that project rather than landing unattributed on the org
 * board.
 */
function FeedComposer({
  onCreated,
}: {
  onCreated: (input: FeedComposeInput) => void;
}) {
  const t = useT();
  const deliveryEnabled = useOrgFlag("delivery_lanes_enabled");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<TaskBoardItemStatus>(
    CANONICAL_COLUMN_KEYS[0],
  );
  const [priority, setPriority] = useState<TaskBoardItemPriority>("medium");
  const [type, setType] = useState<TaskBoardItemType>(DEFAULT_TASK_TYPE);
  /** The description field appears once someone starts writing, not before:
   *  at rest the composer is one line, so the feed under it is what the page
   *  is about. State rather than `:focus-within` because picking a property
   *  moves focus into a portaled menu, and a field that vanished while its
   *  menu was open would shift the very row the menu hangs from. */
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
    <div className="flex flex-col rounded-[var(--studio-surface-radius,var(--radius-xl))] bg-card card-shadow focus-within:ring-[2px] focus-within:ring-ring/20">
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
              {moveTargets(deliveryEnabled).map((s) => {
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

/**
 * The board as a reading order: every visible card, newest first, under the day
 * it last moved on.
 *
 * `now` is read once per render rather than per row so a group and its rows
 * cannot disagree about what "today" is across a midnight boundary. The day
 * header is sticky: which day a row belongs to must be answerable without
 * scrolling back up to find out.
 */
/**
 * What is happening right now, beside the feed rather than inside it.
 *
 * The rail used to list the project's owner, repo and folder — true whether or
 * not anything is happening, and already answered by project settings and the
 * Library. A feed is read to find out what is going on, so its margin answers
 * the two live questions the rows themselves scroll away from: which agents are
 * working this second, and what has stopped waiting on a person. Both are
 * derived from the cards already on screen, so nothing new is fetched and the
 * rail cannot disagree with the feed beside it.
 *
 * Only rendered for the project overview's inline feed: the org-wide board
 * would need to name a project on every row, which is the feed's own job.
 */
function FeedRail({
  items,
  now,
  onOpen,
}: {
  items: TaskBoardItem[];
  /** Read once by the feed and handed down, so the rail's ages and the day
   *  headers beside them cannot disagree about when "now" is. */
  now: Date;
  onOpen: (item: TaskBoardItem) => void;
}) {
  const t = useT();
  const rail = feedRail(items);

  return (
    <aside className="flex w-full shrink-0 flex-col gap-5 self-start overflow-y-auto pt-3 @4xl:w-[260px]">
      <section className="flex flex-col gap-1">
        <h3 className="flex items-center gap-2 px-2 pb-1 text-xs font-medium text-muted-foreground">
          <span
            className={cn(
              "size-1.5 rounded-full",
              rail.runningTotal > 0 ? "animate-pulse bg-success" : "bg-border",
            )}
            aria-hidden
          />
          {t("taskBoard.feed.railRunning")}
          {rail.runningTotal > 0 && (
            <span className="tabular-nums">{rail.runningTotal}</span>
          )}
        </h3>
        {rail.running.length === 0 ? (
          <p className="px-2 text-xs text-muted-foreground">
            {t("taskBoard.feed.railIdle")}
          </p>
        ) : (
          rail.running.map(({ item, thread }) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onOpen(item)}
              className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent/60"
            >
              <SuperAgentIcon size={16} className="mt-0.5 shrink-0" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm text-foreground">
                  {item.title}
                </span>
                {thread.lastMessage && (
                  <span className="truncate text-xs text-muted-foreground">
                    {thread.lastMessage}
                  </span>
                )}
              </span>
              <span className="shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">
                {compactElapsed(thread.createdAt, now.getTime())}
              </span>
            </button>
          ))
        )}
      </section>

      {rail.waiting.length > 0 && (
        <section className="flex flex-col gap-1">
          <h3 className="flex items-center gap-2 px-2 pb-1 text-xs font-medium text-muted-foreground">
            <span className="size-1.5 rounded-full bg-warning" aria-hidden />
            {t("taskBoard.feed.railWaiting")}
            <span className="tabular-nums">{rail.waitingTotal}</span>
          </h3>
          {rail.waiting.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onOpen(item)}
              className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent/60"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                {item.title}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {compactElapsed(item.updatedAt, now.getTime())}
              </span>
            </button>
          ))}
        </section>
      )}
    </aside>
  );
}

function FeedView({
  items,
  index,
  memberByUserId,
  onCompose,
  onOpen,
  project,
}: {
  items: TaskBoardItem[];
  index: ProjectIndex;
  memberByUserId: Map<string, Member>;
  onCompose: (input: FeedComposeInput) => void;
  onOpen: (item: TaskBoardItem) => void;
  /** Present only for the project overview's inline feed — see `FeedRail`. */
  project?: VirtualMCPEntity;
}) {
  const t = useT();
  const now = new Date();
  const days = groupFeedByDay(items, now);

  return (
    /* The composer and the rail sit OUTSIDE the scrolling region, and only the
       posts scroll. Inside it they scrolled away — the reply box you came to
       use, and the live status the rail exists to keep in view — and, worse,
       they were sliced flat against the tabs above on the way out. */
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col",
        project ? "px-4 pt-4 md:px-8" : "px-4 pt-6 sm:px-8",
      )}
    >
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-6",
          project
            ? "w-full max-w-[1040px] @4xl:flex-row"
            : "mx-auto w-full max-w-[760px]",
        )}
      >
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
                      /* Every card on this feed IS `project` already — the
                         chip would repeat the screen's own name on every row. */
                      bucket={project ? null : entryForTask(item, index)}
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
        {project && <FeedRail items={items} now={now} onOpen={onOpen} />}
      </div>
    </div>
  );
}

/**
 * The board as one column, grouped by lane in the board's own order — the
 * status a reader scans for is a heading, not a glyph to decode on every row.
 * A lane with nothing in it gets no heading: a list is read top to bottom, and
 * an empty group is a line that says "keep going".
 */
function ListView({
  items,
  memberByUserId,
  onOpen,
  inlineTabs,
}: {
  items: TaskBoardItem[];
  memberByUserId: Map<string, Member>;
  onOpen: (item: TaskBoardItem) => void;
  inlineTabs?: boolean;
}) {
  const t = useT();
  const known = CANONICAL_COLUMN_KEYS as readonly string[];
  const order = [
    ...known,
    ...items.map((i) => i.status).filter((s) => !known.includes(s)),
  ];
  const groups = order
    .map((status) => ({
      status,
      items: items.filter((i) => i.status === status).sort(bySortOrder),
    }))
    .filter((g) => g.items.length > 0);

  return (
    <div
      className={cn(
        "min-h-0 flex-1 overflow-y-auto pb-16",
        inlineTabs ? "px-4 pt-4 md:px-8" : "px-4 pt-6 sm:px-8",
      )}
    >
      <div className="mx-auto flex w-full max-w-[1680px] flex-col gap-6">
        {groups.map((group) => {
          const { label, visual } = laneHeader(group.status, t);
          const LaneIcon = visual.icon;
          return (
            <section key={group.status} className="flex flex-col">
              <h2 className="sticky top-0 z-10 flex h-9 items-center gap-2 bg-background px-3 text-sm font-medium text-foreground">
                <LaneIcon
                  size={15}
                  className={cn(
                    "shrink-0",
                    visual.iconClassName.replace(/\banimate-\S+\b/g, "").trim(),
                  )}
                />
                {label}
                <span className="text-xs font-normal tabular-nums text-muted-foreground">
                  {group.items.length}
                </span>
              </h2>
              <div className="flex flex-col divide-y divide-border border-y border-border">
                {group.items.map((item) => (
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
                    onOpen={() => onOpen(item)}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** One row, one line. Every fact sits in a fixed slot so a column of rows
 *  aligns: priority, key, title, then labels, assignee and age at the right. */
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
  const { org } = useProjectContext();
  const key = taskKey(org.slug, item.keySeq);
  const runState = agentRunState(item);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex h-11 items-center gap-3 px-3 text-left transition-colors hover:bg-accent/40"
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {item.priority !== "none" && <PriorityIcon priority={item.priority} />}
      </span>
      {key && (
        <span className="hidden w-16 shrink-0 font-mono text-xs text-muted-foreground sm:inline">
          {key}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {item.title}
      </span>
      {runState && <AgentRunIndicator state={runState} />}
      {isTaskBlocked(item) && <BlockedBadge />}
      {isTaskHandedToHuman(item) && <HandedToHumanBadge />}
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
      {item.dueDate && (
        <span className="hidden sm:inline-flex">
          <DueDatePill iso={item.dueDate} />
        </span>
      )}
      <span className="flex w-5 shrink-0 justify-center">
        <AssigneeDisplay
          item={item}
          assignee={assignee}
          assignedBy={assignedBy}
        />
      </span>
      <span className="hidden w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:inline">
        {formatTimeAgo(new Date(item.createdAt))}
      </span>
    </button>
  );
}
