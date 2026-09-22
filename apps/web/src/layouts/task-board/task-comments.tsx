/**
 * Comments on a task — threads inside the activity feed, with one level of
 * replies. The new layout uses one composer; classic keeps inline replies.
 *
 * Presentation only: the data and the mutations come from
 * `useTaskBoardComments`, and the dialog maps a comment's `authorId` to a
 * member before handing it here.
 *
 * No attach affordance: the paperclip belongs with attachment storage. The
 * composer is a Tiptap field rather than a textarea for one reason — an
 * `@`-mention needs a chip and a user id, not the name the user happened to
 * type.
 */

import { Fragment, useRef, useState } from "react";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { ArrowUp, DotsHorizontal, Trash03 } from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import { SuperAgentIcon } from "@/components/super-agent-icon";
import { ReviewerIcon } from "@/components/reviewer-icon";
import { getInitials } from "@/lib/get-initials";
import { MemoizedMarkdown } from "@/components/chat/markdown";
import { formatTimeAgo } from "@/lib/format-time";
import { TaskMessage } from "./task-message";
import { useT } from "@/i18n/use-t.ts";
import {
  MentionInput,
  type MentionInputHandle,
} from "@/components/markdown-editor/mention-input";

export type CommentAuthor = {
  id: string;
  name: string;
  image?: string | null;
  /** The Super Agent signs with its glyph instead of an avatar. */
  isAgent?: boolean;
  isReviewer?: boolean;
};

/** A comment as the feed renders it. `replies` is only ever one level deep,
 *  like Linear. */
export type TaskComment = {
  id: string;
  author: CommentAuthor;
  body: string;
  createdAt: string;
  onOpenThread?: () => void;
  replies: TaskComment[];
  /** Stored state is retained for compatibility, but does not hide comments. */
  resolved?: boolean;
};

/**
 * A comment thread: the root comment and its existing replies.
 */
export function CommentThreadCard({
  thread,
  me,
  conversation = true,
  onReply,
  onDelete,
}: {
  thread: TaskComment;
  me: CommentAuthor;
  conversation?: boolean;
  onReply?: (body: string) => void;
  /** `commentId` is the thread root's id when the root itself is deleted. */
  onDelete: (commentId: string) => void;
}) {
  return (
    <div
      className={cn(
        "flex flex-col",
        conversation
          ? "border-b border-border/50 pb-4"
          : "rounded-xl bg-card card-shadow",
      )}
    >
      <CommentEntry
        conversation={conversation}
        comment={thread}
        onDelete={canDelete(thread, me) ? () => onDelete(thread.id) : undefined}
      />
      {thread.replies.map((reply, i) => (
        <Fragment key={reply.id}>
          {/* Between two replies the rule starts at their text, so the run of
              replies reads as one exchange under the root comment. */}
          <Divider inset={i > 0} />
          <CommentEntry
            conversation={conversation}
            comment={reply}
            onDelete={
              canDelete(reply, me) ? () => onDelete(reply.id) : undefined
            }
            isReply
          />
        </Fragment>
      ))}
      {!conversation && onReply && (
        <>
          <Divider />
          <CommentComposer replyAuthor={me} onSubmit={onReply} />
        </>
      )}
    </div>
  );
}

/** You can delete your own comments, and the Super Agent's — it's working
 *  for you, not another person whose comment you shouldn't be able to erase. */
function canDelete(comment: TaskComment, me: CommentAuthor): boolean {
  return comment.author.id === me.id || comment.author.isAgent === true;
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
  conversation,
  comment,
  isReply,
  onDelete,
}: {
  comment: TaskComment;
  conversation: boolean;
  isReply?: boolean;
  /** Omitted for a comment that isn't the current user's — the server
   *  rejects deleting someone else's comment, so don't offer it. */
  onDelete?: () => void;
}) {
  if (!conversation) {
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
          {onDelete && <CommentActionsMenu onDelete={onDelete} />}
        </div>
        <div
          className={cn(
            // One size per comment; the shared markdown pins its own 14px.
            "text-sm leading-relaxed text-foreground [&_li]:text-sm [&_p]:text-sm",
            // Avatar (24px) + gap (8px), so a reply's text starts at the name.
            isReply && "pl-8",
          )}
        >
          <MemoizedMarkdown id={comment.id} text={comment.body} />
        </div>
      </div>
    );
  }
  return (
    <TaskMessage
      id={comment.id}
      commentId={comment.id}
      author={comment.author.name}
      avatar={<AuthorGlyph author={comment.author} />}
      createdAt={comment.createdAt}
      body={comment.body}
      isReply={isReply}
      onOpenThread={comment.onOpenThread}
      actions={onDelete && <CommentActionsMenu onDelete={onDelete} />}
    />
  );
}

/**
 * Per-comment overflow menu. Hidden until the comment is hovered or the trigger
 * is focused, so a quiet thread stays quiet — but pinned open while the menu
 * is, or it would vanish from under the pointer.
 */
function CommentActionsMenu({ onDelete }: { onDelete?: () => void }) {
  const t = useT();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("taskBoard.taskDialog.commentActionsAriaLabel")}
          className="ml-auto flex size-7 shrink-0 items-center justify-center classic:rounded-md compact:rounded-lg text-muted-foreground opacity-0 transition-colors hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
        >
          <DotsHorizontal size={16} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
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
  if (author.isReviewer) return <ReviewerIcon size={24} />;
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
 * Task conversation composer. Enter sends, Shift+Enter breaks the line.
 */
type SubmitComment = (body: string) => void | boolean | Promise<void | boolean>;

export function NewCommentComposer({ onSubmit }: { onSubmit: SubmitComment }) {
  return <CommentComposer onSubmit={onSubmit} />;
}

function CommentComposer({
  onSubmit,
  replyAuthor,
}: {
  onSubmit: SubmitComment;
  replyAuthor?: CommentAuthor;
}) {
  const t = useT();
  const ref = useRef<MentionInputHandle>(null);
  const [empty, setEmpty] = useState(true);

  const submit = () => ref.current?.submit();

  const textarea = (
    <MentionInput
      ref={ref}
      placeholder={t(
        replyAuthor
          ? "taskBoard.taskDialog.commentReplyPlaceholder"
          : "taskBoard.taskDialog.commentPlaceholder",
      )}
      onSubmit={onSubmit}
      onEmptyChange={setEmpty}
      className={cn(
        "w-full [&_.tiptap]:outline-none",
        !replyAuthor && "min-h-10",
      )}
    />
  );

  const actions = (
    <button
      type="button"
      disabled={empty}
      onClick={submit}
      aria-label={t("taskBoard.taskDialog.commentSubmitAriaLabel")}
      // cursor-pointer: the composer around it sets cursor-text, which would
      // otherwise inherit onto the button.
      className="flex size-7 shrink-0 cursor-pointer items-center justify-center classic:rounded-md compact:rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
    >
      <ArrowUp size={16} />
    </button>
  );

  // The whole composer is the click target, not just the one-line input inside
  // it: the empty space below "Leave a comment..." reads as part of the field,
  // so clicking it should put
  // the caret there. A click that lands on the send button hits the button
  // first and bubbles here after, which only re-focuses the (now empty)
  // composer.
  const focusInput = () => ref.current?.focus();

  if (replyAuthor)
    return (
      <div
        data-testid="reply-composer"
        onClick={focusInput}
        className="relative flex cursor-text items-start gap-2 p-3"
      >
        <span className="mt-0.5 shrink-0">
          <AuthorGlyph author={replyAuthor} />
        </span>
        <div className="min-w-0 flex-1 pt-0.5">{textarea}</div>
        {actions}
      </div>
    );
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
