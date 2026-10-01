/**
 * Comments on a task — threads inside the activity feed, with one level of
 * replies and a shared composer.
 *
 * Presentation only: the data and the mutations come from
 * `useTaskBoardComments`, and the dialog maps a comment's `authorId` to a
 * member before handing it here.
 *
 * The composer is a Tiptap field rather than a textarea for one reason — an
 * `@`-mention needs a chip and a user id, not the name the user happened to
 * type.
 */

import { Fragment, useRef, useState, type DragEvent } from "react";
import { toast } from "sonner";
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
  X,
} from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import { FileTypeIcon } from "@/components/file-type-icon";
import { SuperAgentIcon } from "@/components/super-agent-icon";
import { ReviewerIcon } from "@/components/reviewer-icon";
import { formatBytes } from "@/lib/format-bytes";
import { getInitials } from "@/lib/get-initials";
import { TaskMessage } from "./task-message";
import { useT } from "@/i18n/use-t.ts";
import {
  MentionInput,
  type MentionInputHandle,
} from "@/components/markdown-editor/mention-input";
import { isImageFile, maxUploadMb } from "@/components/markdown-editor/uploads";
import {
  admitAttachments,
  commentBodyWithAttachments,
  MAX_COMMENT_ATTACHMENTS,
  type AttachmentLink,
} from "./comment-attachments";
import { useCommentAttachmentUpload } from "@/layouts/task-board/use-comment-attachment-upload";

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
  taskId: string;
  onSubmit: SubmitComment;
}) {
  return <CommentComposer taskId={taskId} onSubmit={onSubmit} />;
}

/** A file waiting in the draft. */
type PendingAttachment = {
  id: string;
  file: File;
  /** An object URL for an image's thumbnail, released once it has loaded. */
  previewUrl: string | null;
  /** Set once uploaded, so a retry after a failed post doesn't upload it again. */
  link: AttachmentLink | null;
};

function hasFiles(event: DragEvent) {
  return event.dataTransfer.types.includes("Files");
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
  const fileInput = useRef<HTMLInputElement>(null);
  const [empty, setEmpty] = useState(true);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  // The draft files a send in flight is posting; files added meanwhile wait for the next one.
  const [sendingIds, setSendingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const sending = sendingIds.size > 0;
  // Counted, not a flag: crossing the field's children fires a leave per enter.
  const [dragDepth, setDragDepth] = useState(0);
  const { store } = useCommentAttachmentUpload(taskId);

  const addFiles = (files: File[]) => {
    const { accepted, rejected } = admitAttachments(files, pending.length);
    for (const { file, reason } of rejected) {
      if (reason === "too-large") {
        toast.error(
          t("markdownEditor.fileTooLarge", {
            name: file.name,
            max: String(maxUploadMb(file)),
          }),
        );
      }
    }
    if (rejected.some(({ reason }) => reason === "too-many")) {
      toast.error(
        t("taskBoard.taskDialog.commentAttachmentLimit", {
          max: String(MAX_COMMENT_ATTACHMENTS),
        }),
      );
    }
    if (accepted.length === 0) return;
    setPending((prev) => [
      ...prev,
      ...accepted.map((file) => ({
        id: crypto.randomUUID(),
        file,
        previewUrl: isImageFile(file) ? URL.createObjectURL(file) : null,
        link: null,
      })),
    ]);
  };

  // An uploaded file stays put: a failed post may still have landed, and its comment would link here.
  const removeAttachment = (item: PendingAttachment) => {
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    setPending((prev) => prev.filter((p) => p.id !== item.id));
  };

  const postWithAttachments = async (text: string) => {
    const sent = pending;
    setSendingIds(new Set(sent.map((item) => item.id)));
    try {
      const outcomes = await Promise.all(
        sent.map(async (item) => {
          try {
            return { item, link: item.link ?? (await store(item.file)) };
          } catch {
            return { item, link: null };
          }
        }),
      );
      setPending((prev) =>
        prev.map((p) => ({
          ...p,
          link: outcomes.find((o) => o.item.id === p.id)?.link ?? p.link,
        })),
      );
      const failed = outcomes.filter((o) => !o.link);
      if (failed.length > 0) {
        for (const { item } of failed) {
          toast.error(
            t("markdownEditor.uploadFailed", { name: item.file.name }),
          );
        }
        return false;
      }
      const links = outcomes.flatMap((o) => (o.link ? [o.link] : []));
      const posted = await onSubmit(commentBodyWithAttachments(text, links));
      if (posted === false) return false;
      // Files added while this one was sending stay for the next comment.
      const sentIds = new Set(sent.map((item) => item.id));
      setPending((prev) => prev.filter((p) => !sentIds.has(p.id)));
      return posted;
    } finally {
      setSendingIds(new Set());
    }
  };

  const submit = () => ref.current?.submit();

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
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDragDepth((n) => n + 1);
      }}
      onDragOver={(e) => {
        if (hasFiles(e)) e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (hasFiles(e)) setDragDepth((n) => Math.max(0, n - 1));
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        // Ours, not the chat composer's window-level drop listener's (`useWindowFileDrop`).
        e.stopPropagation();
        setDragDepth(0);
        addFiles(Array.from(e.dataTransfer.files));
      }}
      className={cn(
        "relative flex cursor-text flex-col gap-1 rounded-xl bg-card p-3 card-shadow",
        dragDepth > 0 &&
          "outline-2 outline-offset-2 outline-dashed outline-ring/40",
      )}
    >
      <MentionInput
        ref={ref}
        placeholder={t("taskBoard.taskDialog.commentPlaceholder")}
        onSubmit={postWithAttachments}
        onEmptyChange={setEmpty}
        allowEmptySubmit={pending.length > 0}
        onPasteFiles={addFiles}
        className={cn("w-full [&_.tiptap]:outline-none", "min-h-10")}
      />
      {pending.length > 0 && (
        <ul
          aria-label={t("taskBoard.taskDialog.commentAttachments")}
          className="flex flex-wrap gap-2 pt-1"
        >
          {pending.map((item) => (
            <PendingAttachmentTile
              key={item.id}
              item={item}
              uploading={sendingIds.has(item.id) && !item.link}
              disabled={sendingIds.has(item.id)}
              onRemove={() => removeAttachment(item)}
            />
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between">
        <IconButton
          label={t("markdownEditor.attachFile")}
          className="text-muted-foreground"
          onClick={() => fileInput.current?.click()}
        >
          <Attachment01 size={16} />
        </IconButton>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []));
            // Picking the same file again must still fire a change.
            e.target.value = "";
          }}
        />
        <IconButton
          label={t("taskBoard.taskDialog.commentSubmitAriaLabel")}
          className="text-muted-foreground"
          disabled={(empty && pending.length === 0) || sending}
          onClick={submit}
        >
          {sending ? <Spinner size="xs" /> : <ArrowUp size={16} />}
        </IconButton>
      </div>
    </div>
  );
}

/** A file in the draft: a thumbnail for an image, a named chip for anything else. */
function PendingAttachmentTile({
  item,
  uploading,
  disabled,
  onRemove,
}: {
  item: PendingAttachment;
  uploading: boolean;
  disabled: boolean;
  onRemove: () => void;
}) {
  const t = useT();
  const { file, previewUrl } = item;

  return (
    <li
      className={cn(
        "surface-inset relative flex h-14 items-center overflow-hidden",
        previewUrl ? "w-14" : "max-w-60 gap-2 pl-2.5 pr-8",
      )}
    >
      {previewUrl ? (
        <img
          src={previewUrl}
          alt={file.name}
          onLoad={() => URL.revokeObjectURL(previewUrl)}
          onError={() => URL.revokeObjectURL(previewUrl)}
          className="size-full object-cover"
        />
      ) : (
        <>
          <FileTypeIcon filename={file.name} className="h-8 w-6 shrink-0" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm text-foreground">
              {file.name}
            </span>
            <span className="text-meta">{formatBytes(file.size)}</span>
          </span>
        </>
      )}
      {uploading && (
        <span className="absolute inset-0 flex items-center justify-center bg-card/60 text-muted-foreground">
          <Spinner size="xs" />
        </span>
      )}
      <button
        type="button"
        aria-label={t("taskBoard.taskDialog.commentRemoveAttachment", {
          name: file.name,
        })}
        disabled={disabled}
        onClick={(e) => {
          // Not a click into the field: keep the caret where it was.
          e.stopPropagation();
          onRemove();
        }}
        className={cn(
          "focus-ring absolute flex size-5 items-center justify-center rounded-full bg-foreground/70 text-background transition-opacity hover:bg-foreground disabled:opacity-0",
          previewUrl ? "right-1 top-1" : "right-2 top-1/2 -translate-y-1/2",
        )}
      >
        <X size={12} />
      </button>
    </li>
  );
}
