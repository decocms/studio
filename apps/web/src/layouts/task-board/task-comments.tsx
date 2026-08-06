/**
 * Comments on a task — threads inside the activity feed, with one level of
 * replies and an inline reply composer per thread.
 *
 * Presentation only: the data and the mutations come from
 * `useTaskBoardComments`, and the dialog maps a comment's `authorId` to a
 * member before handing it here.
 *
 * No attach affordance and no `@`-mentions: the paperclip belongs with
 * attachment storage, and a mention is only worth typing once mentioning
 * someone notifies them. Both are additions, not omissions to paper over.
 */

import { Fragment, useRef, useState } from "react";
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
import { MemoizedMarkdown } from "@/components/chat/markdown";
import { SuperAgentIcon } from "@/components/super-agent-icon";
import { getInitials } from "@/lib/get-initials";
import { formatTimeAgo } from "@/lib/format-time";
import { useT, type TFunction } from "@/i18n/use-t.ts";

export type CommentAuthor = {
  id: string;
  name: string;
  image?: string | null;
  /** The Super Agent signs with its glyph instead of an avatar. */
  isAgent?: boolean;
};

/** A comment as the feed renders it. `replies` is only ever one level deep,
 *  like Linear. */
export type TaskComment = {
  id: string;
  author: CommentAuthor;
  body: string;
  createdAt: string;
  replies: TaskComment[];
  /** Thread roots only — a thread is settled or open as a whole. */
  resolved?: boolean;
};

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
  onReply,
  onDelete,
  onToggleResolved,
}: {
  thread: TaskComment;
  me: CommentAuthor;
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
        onDelete={canDelete(thread, me) ? () => onDelete(thread.id) : undefined}
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
            onDelete={
              canDelete(reply, me) ? () => onDelete(reply.id) : undefined
            }
            isReply
          />
        </Fragment>
      ))}
      <Divider />
      <CommentComposer
        variant="reply"
        placeholder={t("taskBoard.taskDialog.commentReplyPlaceholder")}
        author={me}
        onSubmit={onReply}
      />
    </div>
  );
}

/** You can delete your own comments, and the Super Agent's — it's working
 *  for you, not another person whose comment you shouldn't be able to erase. */
function canDelete(comment: TaskComment, me: CommentAuthor): boolean {
  return comment.author.id === me.id || comment.author.isAgent === true;
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
  onSubmit,
}: {
  me: CommentAuthor;
  onSubmit: (body: string) => void;
}) {
  const t = useT();

  return (
    <CommentComposer
      variant="root"
      placeholder={t("taskBoard.taskDialog.commentPlaceholder")}
      author={me}
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
  isReply,
  resolved,
  onDelete,
  onToggleResolved,
}: {
  comment: TaskComment;
  isReply?: boolean;
  resolved?: boolean;
  /** Omitted for a comment that isn't the current user's — the server
   *  rejects deleting someone else's comment, so don't offer it. */
  onDelete?: () => void;
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
        {(onDelete || onToggleResolved) && (
          <CommentActionsMenu
            resolved={resolved}
            onDelete={onDelete}
            onToggleResolved={onToggleResolved}
          />
        )}
      </div>
      <div
        className={cn(
          // Same size as the task's description: a comment is body prose, not
          // metadata like the name and timestamp above it.
          "text-[15px] leading-relaxed text-foreground",
          // Avatar (24px) + gap (8px), so a reply's text starts at the name.
          isReply && "pl-8",
        )}
      >
        <MemoizedMarkdown id={comment.id} text={comment.body} />
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
  onDelete?: () => void;
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
        {onDelete && (
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            <Trash03 size={16} />
            {t("taskBoard.taskDialog.commentDelete")}
          </DropdownMenuItem>
        )}
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
 * Composer for a comment or a reply. Enter sends, Shift+Enter breaks the line.
 */
function CommentComposer({
  variant,
  placeholder,
  author,
  onSubmit,
}: {
  variant: "root" | "reply";
  placeholder: string;
  author: CommentAuthor;
  onSubmit: (body: string) => void;
}) {
  const t = useT();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");

  const submit = () => {
    const body = value.trim();
    if (!body) return;
    onSubmit(body);
    setValue("");
    const el = ref.current;
    if (el) {
      el.value = "";
      autoGrow(el);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const textarea = (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => {
        setValue(e.currentTarget.value);
        autoGrow(e.currentTarget);
      }}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      rows={1}
      className={cn(
        "w-full resize-none overflow-hidden border-0 bg-transparent text-[15px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground",
        variant === "root" && "min-h-10",
      )}
    />
  );

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
    </div>
  );
}

/** Grow a composer to fit its text instead of scrolling inside itself. */
function autoGrow(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}
