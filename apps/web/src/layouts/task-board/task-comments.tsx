/**
 * Comments on a task — threads inside the activity feed, with one level of
 * replies and a shared composer.
 *
 * Presentation only: the data and the mutations come from
 * `useTaskBoardComments`, and the dialog maps a comment's `authorId` to a
 * member before handing it here.
 *
 * The composer is a Tiptap field rather than a textarea because an
 * `@`-mention needs a chip and a user id, not the name the user happened to
 * type — and an attachment needs a preview.
 */

import { Fragment, useRef, useState } from "react";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { IconButton } from "@decocms/ui/components/icon-button.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import {
  ArrowUp,
  Attachment01,
  DotsHorizontal,
  Trash03,
} from "@untitledui/icons";
import { toast } from "sonner";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useCommentAttachments } from "@/hooks/use-comment-attachments";
import { SuperAgentIcon } from "@/components/super-agent-icon";
import { ReviewerIcon } from "@/components/reviewer-icon";
import { getInitials } from "@/lib/get-initials";
import { TaskMessage } from "./task-message";
import { useT } from "@/i18n/use-t.ts";
import {
  MentionInput,
  type DraftAttachment,
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
  onDelete,
}: {
  thread: TaskComment;
  me: CommentAuthor;
  /** `commentId` is the thread root's id when the root itself is deleted. */
  onDelete: (commentId: string) => void;
}) {
  return (
    <div className={cn("flex flex-col", "border-b border-border/50 pb-4")}>
      <CommentEntry
        comment={thread}
        onDelete={canDelete(thread, me) ? () => onDelete(thread.id) : undefined}
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
  comment,
  isReply,
  onDelete,
}: {
  comment: TaskComment;
  isReply?: boolean;
  /** Omitted for a comment that isn't the current user's — the server
   *  rejects deleting someone else's comment, so don't offer it. */
  onDelete?: () => void;
}) {
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
          className="ml-auto flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground opacity-0 transition-colors hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
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

export function NewCommentComposer({
  taskId,
  onSubmit,
}: {
  /** The task the comment's attachments are filed under. */
  taskId: string;
  onSubmit: SubmitComment;
}) {
  return <CommentComposer taskId={taskId} onSubmit={onSubmit} />;
}

function CommentComposer({
  taskId,
  onSubmit,
}: {
  taskId: string;
  onSubmit: SubmitComment;
}) {
  const t = useT();
  const ref = useRef<MentionInputHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [empty, setEmpty] = useState(true);
  const [sending, setSending] = useState(false);
  const attachments = useCommentAttachments(taskId);
  // Draft preview URL → upload behind a failed post, which may have landed anyway.
  const [landed] = useState(
    () => new Map<string, { path: string; url: string }>(),
  );

  const submit = () => ref.current?.submit();

  // Every file uploads, or none is kept: a comment never posts with a hole.
  const send = async (markdown: string, attached: DraftAttachment[]) => {
    setSending(true);
    try {
      const results = await Promise.allSettled(
        attached.map(async (draft) => ({
          draft,
          ...(landed.get(draft.url) ?? (await attachments.upload(draft.file))),
        })),
      );
      const uploaded = results.flatMap((r) =>
        r.status === "fulfilled" ? [r.value] : [],
      );
      const failed = attached.find(
        (draft) => !uploaded.some((u) => u.draft === draft),
      );
      if (failed) {
        void attachments.remove(
          uploaded.filter((u) => !landed.has(u.draft.url)).map((u) => u.path),
        );
        toast.error(
          t("taskBoard.taskDialog.attachmentUploadFailed", {
            name: failed.file.name,
          }),
        );
        return false;
      }
      const body = uploaded.reduce(
        (text, u) => text.replaceAll(u.draft.url, u.url),
        markdown,
      );
      if ((await onSubmit(body)) === false) {
        for (const u of uploaded) {
          landed.set(u.draft.url, { path: u.path, url: u.url });
        }
        return false;
      }
      landed.clear();
      return true;
    } finally {
      setSending(false);
    }
  };

  const textarea = (
    <MentionInput
      ref={ref}
      placeholder={t("taskBoard.taskDialog.commentPlaceholder")}
      onSubmit={send}
      onEmptyChange={setEmpty}
      className={cn(
        "w-full [&_.tiptap]:outline-none",
        "min-h-10",
        // A screenshot is context for the text, not the point of the card.
        "[&_img]:max-h-40",
      )}
    />
  );

  const actions = (
    <IconButton
      label={t("taskBoard.taskDialog.commentSubmitAriaLabel")}
      disabled={empty || sending}
      onClick={submit}
    >
      {sending ? <Spinner className="size-4" /> : <ArrowUp size={16} />}
    </IconButton>
  );

  // The whole composer is the click target, not just the one-line input inside
  // it: the empty space below "Leave a comment..." reads as part of the field,
  // so clicking it should put
  // the caret there. A click that lands on the send button hits the button
  // first and bubbles here after, which only re-focuses the (now empty)
  // composer.
  const focusInput = () => ref.current?.focus();

  return (
    <div
      data-testid="new-comment-composer"
      onClick={focusInput}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        // A drop on the text itself is the field's; this catches the rest of the card.
        const files = Array.from(e.dataTransfer.files);
        if (files.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        ref.current?.attach(files);
      }}
      className="relative flex cursor-text flex-col gap-1 rounded-xl bg-card p-3 card-shadow"
    >
      {textarea}
      <div className="flex items-center justify-between">
        <IconButton
          label={t("taskBoard.taskDialog.attachFile")}
          disabled={sending}
          onClick={() => fileInputRef.current?.click()}
        >
          <Attachment01 size={16} />
        </IconButton>
        {actions}
      </div>
      {/* No `accept`: images become previews, everything else a file chip. */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          ref.current?.attach(Array.from(e.target.files ?? []));
          // Let the same file be picked again after it was removed.
          e.target.value = "";
        }}
      />
    </div>
  );
}
