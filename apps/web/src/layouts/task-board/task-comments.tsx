/**
 * Comments on a task — threads inside the activity feed, with one level of
 * replies, an inline reply composer per thread, and @-mentions of members,
 * the Super Agent, and other tasks.
 *
 * This file is presentation plus the two mappings between it and the wire:
 * `buildCommentThreads` nests the server's flat rows, and `detectMentions`
 * resolves the `@labels` in a body back to ids at submit time. The data itself
 * lives in `useTaskBoardComments` (query + mutations + SSE).
 *
 * Mentioning the Super Agent starts a run on the task; its answer arrives as a
 * reply over SSE, and the thread shows it typing until then. Mentioning a member
 * is recorded but notifies nobody yet — there's no notification system to hand
 * it to. Attachments are also still missing, which is why the composer has no
 * paperclip: it lands with the storage that makes it work, not before.
 */

import { Fragment, useRef, useState, type ReactNode } from "react";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import {
  ArrowUp,
  Check,
  ChevronSelectorVertical,
  DotsHorizontal,
  MessageCheckCircle,
  Trash03,
  X,
} from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import { SuperAgentIcon } from "@/components/super-agent-icon";
import { getInitials } from "@/lib/get-initials";
import { formatTimeAgo } from "@/lib/format-time";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import {
  STATUS_CONFIG,
  type Member,
  type TaskBoardItem,
  type TaskBoardItemStatus,
} from "./config";

export type CommentAuthor = {
  id: string;
  name: string;
  image?: string | null;
  /** The Super Agent signs with its glyph instead of an avatar. */
  isAgent?: boolean;
};

/** A comment. `replies` is only ever one level deep, like Linear. */
export type TaskComment = {
  id: string;
  author: CommentAuthor;
  body: string;
  createdAt: string;
  replies: TaskComment[];
  /** Thread roots only — a thread is settled or open as a whole. */
  resolved?: boolean;
};

/** Something an `@` can point at from a comment. */
export type Mentionable =
  | {
      kind: "user";
      id: string;
      label: string;
      image?: string | null;
      isAgent?: boolean;
    }
  | { kind: "task"; id: string; label: string; status: TaskBoardItemStatus };

/**
 * Mention targets for a task's comments: the org's people (Super Agent first,
 * since mentioning it is how you hand the task over), then the other tasks on
 * the board.
 */
export function buildMentionables({
  members,
  tasks,
  currentTaskId,
  superAgentLabel,
}: {
  members: Member[];
  tasks: TaskBoardItem[];
  currentTaskId: string;
  superAgentLabel: string;
}): Mentionable[] {
  return [
    {
      kind: "user" as const,
      id: SUPER_AGENT_MENTION_ID,
      label: superAgentLabel,
      isAgent: true,
    },
    ...members.map((m) => ({
      kind: "user" as const,
      id: m.userId,
      label: m.user?.name ?? m.userId,
      image: m.user?.image,
    })),
    ...tasks
      .filter((task) => task.id !== currentTaskId)
      .map((task) => ({
        kind: "task" as const,
        id: task.id,
        label: task.title,
        status: task.status,
      })),
  ];
}

/** Mention id for the Super Agent (it has no member row). */
const SUPER_AGENT_MENTION_ID = "super-agent";

/**
 * Server rows → the nested threads this file renders. Replies hang off their
 * root in the order they were written; a reply whose root is gone is dropped
 * (the server cascades those, so it only ever happens mid-flight).
 *
 * An author with no id is the Super Agent — that's how the server signs a run's
 * answer, since it has no member row.
 */
export function buildCommentThreads(
  rows: {
    id: string;
    parentId: string | null;
    authorId: string | null;
    body: string;
    resolved: boolean;
    createdAt: string;
  }[],
  {
    authorFor,
    superAgentLabel,
  }: {
    authorFor: (userId: string) => CommentAuthor;
    superAgentLabel: string;
  },
): TaskComment[] {
  const toComment = (row: (typeof rows)[number]): TaskComment => ({
    id: row.id,
    author: row.authorId
      ? authorFor(row.authorId)
      : { id: SUPER_AGENT_MENTION_ID, name: superAgentLabel, isAgent: true },
    body: row.body,
    createdAt: row.createdAt,
    replies: [],
    resolved: row.resolved,
  });

  const roots = new Map<string, TaskComment>();
  for (const row of rows) {
    if (!row.parentId) roots.set(row.id, toComment(row));
  }
  for (const row of rows) {
    if (!row.parentId) continue;
    roots.get(row.parentId)?.replies.push(toComment(row));
  }
  return [...roots.values()];
}

/**
 * The `@` targets a comment body points at. A mention is written as its display
 * label, so this is the same longest-label-first match `renderCommentBody` uses
 * to chip them — resolved at submit time, since labels collide and the server
 * can't re-derive ids from prose.
 */
export function detectMentions(
  body: string,
  mentionables: Mentionable[],
): { kind: "user" | "task"; id: string }[] {
  const byLabel = new Map(mentionables.map((m) => [m.label, m]));
  return mentionLabelsIn(body, mentionables)
    .map((label) => byLabel.get(label))
    .filter((m): m is Mentionable => !!m)
    .map((m) => ({ kind: m.kind, id: m.id }));
}

/**
 * A comment thread: the root comment, its replies, and a reply composer.
 *
 * A resolved thread collapses to a one-line summary — the conversation is
 * settled, so it should stop taking up the feed, while staying one click from
 * being read again.
 */
export function CommentThreadCard({
  thread,
  me,
  mentionables,
  agentTyping,
  onReply,
  onDelete,
  onToggleResolved,
}: {
  thread: TaskComment;
  me: CommentAuthor;
  mentionables: Mentionable[];
  /** The Super Agent is working on a mention in this thread — its answer lands
   *  as a reply when the run ends. */
  agentTyping?: boolean;
  onReply: (body: string) => void;
  /** `commentId` is the thread root's id when the root itself is deleted. */
  onDelete: (commentId: string) => void;
  onToggleResolved: () => void;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);

  if (thread.resolved && !expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="flex w-full items-center gap-2.5 rounded-xl bg-card px-4 py-3 text-left card-shadow transition-colors hover:bg-muted/60"
      >
        <MessageCheckCircle
          size={16}
          className="shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
          {resolvedSummary(thread, t)}
        </span>
        <ChevronSelectorVertical
          size={16}
          className="shrink-0 text-muted-foreground"
        />
      </button>
    );
  }

  return (
    <div className="flex flex-col rounded-xl bg-card card-shadow">
      {thread.resolved && (
        <>
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="flex items-center justify-between gap-2 rounded-t-xl bg-muted/40 px-4 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            {t("taskBoard.taskDialog.commentCollapseThread")}
            <X size={14} aria-hidden />
          </button>
          <Divider />
        </>
      )}
      <CommentEntry
        comment={thread}
        mentionables={mentionables}
        onDelete={() => onDelete(thread.id)}
        resolved={thread.resolved}
        onToggleResolved={onToggleResolved}
      />
      {thread.replies.map((reply, i) => (
        <Fragment key={reply.id}>
          {/* Between two replies the rule starts at their text, so the run of
              replies reads as one exchange under the root comment. */}
          <Divider inset={i > 0} />
          <CommentEntry
            comment={reply}
            mentionables={mentionables}
            onDelete={() => onDelete(reply.id)}
            isReply
          />
        </Fragment>
      ))}
      {agentTyping && (
        <>
          <Divider inset={thread.replies.length > 0} />
          <AgentTypingRow />
        </>
      )}
      <Divider />
      <CommentComposer
        variant="reply"
        placeholder={t("taskBoard.taskDialog.commentReplyPlaceholder")}
        author={me}
        mentionables={mentionables}
        onSubmit={onReply}
      />
    </div>
  );
}

/** The Super Agent is drafting a reply to a mention in this thread. */
function AgentTypingRow() {
  const t = useT();
  return (
    <div className="flex items-center gap-2.5 px-4 py-3">
      <SuperAgentIcon size={24} />
      <span className="text-sm text-muted-foreground">
        {t("taskBoard.taskDialog.commentAgentTyping")}
      </span>
      {/* Three dots on the same beat, offset so they read as a wave. */}
      <span className="flex items-center gap-1" aria-hidden>
        {[0, 150, 300].map((delay) => (
          <span
            key={delay}
            className="size-1 animate-pulse rounded-full bg-muted-foreground"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </span>
    </div>
  );
}

/** Authors of a thread, in the order they first spoke. */
const AUTHOR_LIST_FMT = new Intl.ListFormat(undefined, {
  style: "long",
  type: "conjunction",
});

/** "3 resolved comments from valls and Super Agent". */
function resolvedSummary(thread: TaskComment, t: TFunction): string {
  const comments = [thread, ...thread.replies];
  const names = AUTHOR_LIST_FMT.format([
    ...new Set(comments.map((c) => c.author.name)),
  ]);
  return comments.length === 1
    ? t("taskBoard.taskDialog.commentResolvedSummaryOne", { names })
    : t("taskBoard.taskDialog.commentResolvedSummaryMany", {
        count: comments.length,
        names,
      });
}

/** The bottom composer that starts a new thread on the task. */
export function NewCommentComposer({
  me,
  mentionables,
  onSubmit,
}: {
  me: CommentAuthor;
  mentionables: Mentionable[];
  onSubmit: (body: string) => void;
}) {
  const t = useT();

  return (
    <CommentComposer
      variant="root"
      placeholder={t("taskBoard.taskDialog.commentPlaceholder")}
      author={me}
      mentionables={mentionables}
      onSubmit={onSubmit}
    />
  );
}

/**
 * Hairline between entries of a card. Lighter than `border` so it separates
 * comments without competing with the card's own edge. `inset` starts it at a
 * reply's text.
 */
function Divider({ inset }: { inset?: boolean }) {
  // p-4 gutter (16px) + avatar (24px) + gap (8px) = the text's left edge.
  return <span className={cn("h-px bg-border/50", inset && "ml-12")} />;
}

/**
 * One comment. A reply indents its body to the author's name so the thread
 * reads as a conversation under the root comment, not as three equal posts.
 */
function CommentEntry({
  comment,
  mentionables,
  isReply,
  resolved,
  onDelete,
  onToggleResolved,
}: {
  comment: TaskComment;
  mentionables: Mentionable[];
  isReply?: boolean;
  resolved?: boolean;
  onDelete: () => void;
  /** Thread roots only — resolving settles the whole conversation. */
  onToggleResolved?: () => void;
}) {
  return (
    <div className="group flex flex-col gap-1.5 p-4">
      <div className="flex items-center gap-2">
        <AuthorGlyph author={comment.author} />
        <span className="text-sm font-medium text-foreground">
          {comment.author.name}
        </span>
        <span className="text-sm text-muted-foreground">
          {formatTimeAgo(new Date(comment.createdAt))}
        </span>
        <CommentActionsMenu
          resolved={resolved}
          onDelete={onDelete}
          onToggleResolved={onToggleResolved}
        />
      </div>
      <div
        className={cn(
          // Same size as the task's description: a comment is body prose, not
          // metadata like the name and timestamp above it.
          "whitespace-pre-wrap text-[15px] leading-relaxed text-foreground",
          // Avatar (24px) + gap (8px), so a reply's text starts at the name.
          isReply && "pl-8",
        )}
      >
        {renderCommentBody(comment.body, mentionables)}
      </div>
    </div>
  );
}

/**
 * Per-comment overflow menu. Hidden until the comment is hovered or the trigger
 * is focused, so a quiet thread stays quiet — but pinned open while the menu
 * is, or it would vanish from under the pointer.
 */
function CommentActionsMenu({
  resolved,
  onDelete,
  onToggleResolved,
}: {
  resolved?: boolean;
  onDelete: () => void;
  onToggleResolved?: () => void;
}) {
  const t = useT();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("taskBoard.taskDialog.commentActionsAriaLabel")}
          className="ml-auto flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-colors hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
        >
          <DotsHorizontal size={16} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {onToggleResolved && (
          <>
            <DropdownMenuItem onSelect={onToggleResolved}>
              <Check size={16} />
              {resolved
                ? t("taskBoard.taskDialog.commentUnresolveThread")
                : t("taskBoard.taskDialog.commentResolveThread")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <Trash03 size={16} />
          {t("taskBoard.taskDialog.commentDelete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AuthorGlyph({ author }: { author: CommentAuthor }) {
  if (author.isAgent) return <SuperAgentIcon size={24} />;
  return (
    <Avatar
      url={author.image ?? undefined}
      fallback={getInitials(author.name)}
      shape="circle"
      size="xs"
    />
  );
}

/**
 * Composer for a comment or a reply. Enter sends, Shift+Enter breaks the line,
 * and `@` opens the mention menu (which takes over the arrow keys and Enter
 * while it's open).
 */
function CommentComposer({
  variant,
  placeholder,
  author,
  mentionables,
  onSubmit,
}: {
  variant: "root" | "reply";
  placeholder: string;
  author: CommentAuthor;
  mentionables: Mentionable[];
  onSubmit: (body: string) => void;
}) {
  const t = useT();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");
  const [mention, setMention] = useState<MentionToken | null>(null);
  const [active, setActive] = useState(0);

  const matches = mention
    ? filterMentionables(mentionables, mention.query)
    : [];
  const activeIndex = matches.length
    ? Math.min(active, matches.length - 1)
    : -1;

  const sync = (el: HTMLTextAreaElement) => {
    setValue(el.value);
    setMention(mentionTokenAt(el.value, el.selectionStart ?? el.value.length));
    setActive(0);
    autoGrow(el);
  };

  const insert = (target: Mentionable) => {
    const el = ref.current;
    if (!el || !mention) return;
    const caretAt = el.selectionStart ?? value.length;
    const text = `@${target.label} `;
    const next = value.slice(0, mention.start) + text + value.slice(caretAt);
    const caret = mention.start + text.length;
    setValue(next);
    setMention(null);
    // The DOM value only carries the new text after this render commits, so
    // place the caret on the next frame.
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
      autoGrow(el);
    });
  };

  const submit = () => {
    const body = value.trim();
    if (!body) return;
    onSubmit(body);
    setValue("");
    setMention(null);
    const el = ref.current;
    if (el) {
      el.value = "";
      autoGrow(el);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && matches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => (i + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const target = matches[activeIndex];
        if (target) insert(target);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const textarea = (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => sync(e.currentTarget)}
      onKeyDown={onKeyDown}
      onClick={(e) =>
        setMention(
          mentionTokenAt(
            e.currentTarget.value,
            e.currentTarget.selectionStart ?? 0,
          ),
        )
      }
      onBlur={() => setMention(null)}
      placeholder={placeholder}
      rows={1}
      className={cn(
        "w-full resize-none overflow-hidden border-0 bg-transparent text-[15px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground",
        variant === "root" && "min-h-10",
      )}
    />
  );

  // No attach affordance: the paperclip belongs with attachment storage, and
  // a control that can't do anything is worse than no control.
  const actions = (
    <button
      type="button"
      disabled={!value.trim()}
      onClick={submit}
      aria-label={t("taskBoard.taskDialog.commentSubmitAriaLabel")}
      // cursor-pointer: the composer around it sets cursor-text, which would
      // otherwise inherit onto the button.
      className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
    >
      <ArrowUp size={16} />
    </button>
  );

  const menu =
    matches.length > 0 ? (
      <MentionMenu
        matches={matches}
        activeIndex={activeIndex}
        onHover={setActive}
        onSelect={insert}
      />
    ) : null;

  // The whole composer is the click target, not just the one-line input inside
  // it: the empty space below "Leave a comment..." and the gap either side of
  // "Leave a reply..." read as part of the field, so clicking them should put
  // the caret there. A click that lands on the send button hits the button
  // first and bubbles here after, which only re-focuses the (now empty)
  // composer.
  const focusInput = () => ref.current?.focus();

  if (variant === "root") {
    return (
      <div
        data-testid="new-comment-composer"
        onClick={focusInput}
        className="relative flex cursor-text flex-col gap-1 rounded-xl bg-card p-3 card-shadow"
      >
        {textarea}
        <div className="flex items-center justify-end">{actions}</div>
        {menu}
      </div>
    );
  }

  return (
    <div
      data-testid="reply-composer"
      onClick={focusInput}
      className="relative flex cursor-text items-start gap-2 p-3"
    >
      <span className="mt-0.5 shrink-0">
        <AuthorGlyph author={author} />
      </span>
      <div className="min-w-0 flex-1 pt-0.5">{textarea}</div>
      {actions}
      {menu}
    </div>
  );
}

/** The `@…` menu, floated above the composer so it never covers what you type. */
function MentionMenu({
  matches,
  activeIndex,
  onHover,
  onSelect,
}: {
  matches: Mentionable[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (target: Mentionable) => void;
}) {
  const t = useT();

  return (
    <div className="absolute bottom-full left-3 z-20 mb-2 max-h-72 w-[min(20rem,calc(100%-1.5rem))] overflow-y-auto rounded-xl bg-popover p-1 card-shadow">
      {matches.map((target, i) => (
        <Fragment key={`${target.kind}-${target.id}`}>
          {(i === 0 || matches[i - 1]!.kind !== target.kind) && (
            <div className="px-2 pb-1 pt-2 text-xs text-muted-foreground">
              {target.kind === "user"
                ? t("taskBoard.taskDialog.commentMentionUsersHeading")
                : t("taskBoard.taskDialog.commentMentionTasksHeading")}
            </div>
          )}
          <button
            type="button"
            // Keep the caret in the textarea — a blur would close this menu
            // before the click lands.
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => onHover(i)}
            onClick={() => onSelect(target)}
            className={cn(
              "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm",
              i === activeIndex && "bg-muted",
            )}
          >
            <MentionGlyph target={target} />
            <span className="min-w-0 flex-1 truncate text-foreground">
              {target.label}
            </span>
            {target.kind === "user" && target.isAgent && (
              <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                {t("taskBoard.taskDialog.commentMentionAgentBadge")}
              </span>
            )}
          </button>
        </Fragment>
      ))}
    </div>
  );
}

function MentionGlyph({ target }: { target: Mentionable }) {
  if (target.kind === "task") {
    const config = STATUS_CONFIG[target.status];
    return (
      <config.icon size={16} className={cn("shrink-0", config.iconClassName)} />
    );
  }
  if (target.isAgent) return <SuperAgentIcon size={20} />;
  return (
    <Avatar
      url={target.image ?? undefined}
      fallback={getInitials(target.label)}
      shape="circle"
      size="2xs"
    />
  );
}

type MentionToken = { start: number; query: string };

/**
 * The `@…` token the caret sits in, or null when the caret isn't writing a
 * mention. A mention starts a word and ends at the first space, so a plain
 * email address or a mid-word `@` doesn't open the menu.
 */
function mentionTokenAt(value: string, caret: number): MentionToken | null {
  const upToCaret = value.slice(0, caret);
  const start = upToCaret.lastIndexOf("@");
  if (start === -1) return null;
  const before = start === 0 ? "" : upToCaret[start - 1]!;
  if (before && !/\s/.test(before)) return null;
  const query = upToCaret.slice(start + 1);
  if (/\s/.test(query)) return null;
  return { start, query };
}

/** Mention candidates for a query, users before tasks, capped so the menu
 *  stays a menu. */
function filterMentionables(
  mentionables: Mentionable[],
  query: string,
): Mentionable[] {
  const needle = query.toLowerCase();
  const matches = mentionables.filter((m) =>
    m.label.toLowerCase().includes(needle),
  );
  const users = matches.filter((m) => m.kind === "user").slice(0, 5);
  const tasks = matches.filter((m) => m.kind === "task").slice(0, 5);
  return [...users, ...tasks];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches an `@` followed by any target's display label, longest label first
 *  so "@Ana Paula" wins over "@Ana". Null when there's nothing to match. */
function mentionPattern(mentionables: Mentionable[]): RegExp | null {
  if (mentionables.length === 0) return null;
  const labels = mentionables
    .map((m) => m.label)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  return new RegExp(`@(?:${labels.join("|")})`, "g");
}

/** The labels a body mentions, in order, without repeats. */
function mentionLabelsIn(body: string, mentionables: Mentionable[]): string[] {
  const pattern = mentionPattern(mentionables);
  if (!pattern) return [];
  return [
    ...new Set([...body.matchAll(pattern)].map((match) => match[0].slice(1))),
  ];
}

/** A comment's text with its `@mentions` picked out of the prose. */
function renderCommentBody(
  body: string,
  mentionables: Mentionable[],
): ReactNode {
  const pattern = mentionPattern(mentionables);
  if (!pattern) return body;

  const out: ReactNode[] = [];
  let last = 0;
  for (const match of body.matchAll(pattern)) {
    const at = match.index;
    if (at > last) out.push(body.slice(last, at));
    out.push(
      // A chip, so a mention reads as a reference to someone rather than as
      // emphasized prose. Vertical padding only via leading, never `py-*`:
      // padding on an inline box doesn't grow the line, so it would collide
      // with the line above when a comment wraps.
      <span
        key={at}
        className="rounded bg-muted px-1 font-medium text-foreground"
      >
        {match[0]}
      </span>,
    );
    last = at + match[0].length;
  }
  if (last < body.length) out.push(body.slice(last));
  return out;
}

/** Grow a composer to fit its text instead of scrolling inside itself. */
function autoGrow(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}
