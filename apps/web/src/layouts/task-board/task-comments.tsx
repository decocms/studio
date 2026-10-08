/**
 * Comments on a task — threads inside the activity feed, with one level of
 * replies and a shared composer.
 *
 * Presentation only: the data and the mutations come from
 * `useTaskBoardComments`, and the dialog maps a comment's `authorId` to a
 * member before handing it here.
 *
 * Tiptap, not a textarea: a mention and an attachment both render as a chip.
 */

import { Fragment, useRef, useState, type DragEvent } from "react";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import {
  ArrowUp,
  DotsHorizontal,
  Edit03,
  Trash03,
  Upload01,
} from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import { SuperAgentIcon } from "@/components/super-agent-icon";
import { ReviewerIcon } from "@/components/reviewer-icon";
import { getInitials } from "@/lib/get-initials";
import { TaskMessage } from "./task-message";
import { useT } from "@/i18n/use-t.ts";
import { MarkdownEditor } from "@/components/markdown-editor";
import { useEditorUploads } from "@/components/markdown-editor/editor-uploads";
import {
  MentionInput,
  type MentionInputHandle,
} from "@/components/markdown-editor/mention-input";
import {
  AttachFileButton,
  UploadStatus,
} from "@/components/markdown-editor/upload-controls";

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
  /** Handoff between agents, shown only behind the scenes. */
  internal?: boolean;
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
  onEdit,
  onDelete,
}: {
  thread: TaskComment;
  me: CommentAuthor;
  /** False keeps the editor open, so a failed save doesn't lose the edit. */
  onEdit: (commentId: string, body: string) => Promise<boolean>;
  /** `commentId` is the thread root's id when the root itself is deleted. */
  onDelete: (commentId: string) => void;
}) {
  return (
    <div className={cn("flex flex-col", "border-b border-border/50 pb-4")}>
      <CommentEntry
        comment={thread}
        onEdit={
          canEdit(thread, me) ? (body) => onEdit(thread.id, body) : undefined
        }
        onDelete={canDelete(thread, me) ? () => onDelete(thread.id) : undefined}
      />
      {thread.replies.map((reply, i) => (
        <Fragment key={reply.id}>
          {/* Between two replies the rule starts at their text, so the run of
              replies reads as one exchange under the root comment. */}
          <Divider inset={i > 0} />
          <CommentEntry
            comment={reply}
            onEdit={
              canEdit(reply, me) ? (body) => onEdit(reply.id, body) : undefined
            }
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

/** Only your own: the server refuses to edit anyone else's words, the Super
 *  Agent's included. */
function canEdit(comment: TaskComment, me: CommentAuthor): boolean {
  return comment.author.id === me.id;
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
  onEdit,
  onDelete,
}: {
  comment: TaskComment;
  isReply?: boolean;
  onEdit?: (body: string) => Promise<boolean>;
  /** Omitted for a comment that isn't the current user's — the server
   *  rejects deleting someone else's comment, so don't offer it. */
  onDelete?: () => void;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <TaskMessage
      id={comment.id}
      commentId={comment.id}
      author={comment.author.name}
      avatar={<AuthorGlyph author={comment.author} />}
      createdAt={comment.createdAt}
      body={comment.body}
      isReply={isReply}
      muted={comment.internal}
      onOpenThread={comment.onOpenThread}
      editor={
        editing && onEdit ? (
          <CommentEditor
            body={comment.body}
            onSave={onEdit}
            onClose={() => setEditing(false)}
          />
        ) : undefined
      }
      // The editor carries its own Save and Cancel while it's open.
      actions={
        !editing &&
        (onEdit || onDelete) && (
          <CommentActionsMenu
            onEdit={onEdit && (() => setEditing(true))}
            onDelete={onDelete}
          />
        )
      }
    />
  );
}

/**
 * A comment opened for editing where it's read. The full markdown editor, not
 * the composer's one-line field: a comment can carry headings and lists — a
 * summary pasted in, or written through the API — that the composer has no
 * schema for and would flatten on save.
 */
function CommentEditor({
  body,
  onSave,
  onClose,
}: {
  body: string;
  onSave: (body: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(body);
  const [saving, setSaving] = useState(false);
  const next = draft.trim();

  const save = async () => {
    setSaving(true);
    if (await onSave(next)) onClose();
    else setSaving(false);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="surface p-3">
        <MarkdownEditor
          inline
          defaultValue={body}
          onChange={setDraft}
          placeholder={t("taskBoard.taskDialog.commentPlaceholder")}
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
          {t("taskBoard.taskDialog.commentEditCancel")}
        </Button>
        <Button
          size="sm"
          onClick={save}
          disabled={saving || !next || next === body.trim()}
        >
          {t("taskBoard.taskDialog.commentEditSave")}
        </Button>
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
  onEdit,
  onDelete,
}: {
  onEdit?: () => void;
  onDelete?: () => void;
}) {
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
        {onEdit && (
          <DropdownMenuItem onSelect={onEdit}>
            <Edit03 size={16} />
            {t("taskBoard.taskDialog.commentEdit")}
          </DropdownMenuItem>
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

/** Only an OS file drag; a text or chip dragged inside the field is a move. */
function carriesFiles(e: DragEvent) {
  return e.dataTransfer.types.includes("Files");
}

function CommentComposer({ onSubmit }: { onSubmit: SubmitComment }) {
  const t = useT();
  const ref = useRef<MentionInputHandle>(null);
  const [empty, setEmpty] = useState(true);
  const [sending, setSending] = useState(false);
  const uploads = useEditorUploads();
  const [dragging, setDragging] = useState(false);
  /** Enter and leave fire for every child the pointer crosses; this counts
   *  them, so the drop zone hides only when the pointer leaves the card. */
  const dragDepth = useRef(0);

  const submit = () => ref.current?.submit();

  const textarea = (
    <MentionInput
      ref={ref}
      placeholder={t("taskBoard.taskDialog.commentPlaceholder")}
      onSubmit={onSubmit}
      onEmptyChange={setEmpty}
      onSendingChange={setSending}
      uploads={uploads}
      // A full-height screenshot would push the conversation out of the way; the posted comment shows it whole.
      className={cn(
        "w-full [&_.tiptap]:outline-none",
        "min-h-10",
        "[&_img]:max-h-40",
      )}
    />
  );

  const actions = (
    <button
      type="button"
      disabled={empty || uploads.pending > 0}
      onClick={submit}
      aria-label={t("taskBoard.taskDialog.commentSubmitAriaLabel")}
      // cursor-pointer: the composer around it sets cursor-text, which would
      // otherwise inherit onto the button.
      className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
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

  return (
    <div
      data-testid="new-comment-composer"
      onClick={focusInput}
      // Each drag handler stops propagation so the chat composer's window-level drop zone stays down.
      onDragEnter={(e) => {
        if (!carriesFiles(e)) return;
        e.stopPropagation();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (!carriesFiles(e)) return;
        // Without it, a file dropped on the card's padding opens in the tab.
        e.preventDefault();
        e.stopPropagation();
        // Mid-send the field takes no file, so the drop is refused rather than lost.
        if (sending) e.dataTransfer.dropEffect = "none";
      }}
      onDragLeave={(e) => {
        if (!carriesFiles(e)) return;
        e.stopPropagation();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      // Capture: a drop on the text is taken, and stopped, by the editor itself.
      onDropCapture={() => {
        dragDepth.current = 0;
        setDragging(false);
      }}
      onDrop={(e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        ref.current?.attach(Array.from(e.dataTransfer.files));
      }}
      className="relative flex cursor-text flex-col gap-1 rounded-xl bg-card p-3 card-shadow"
    >
      {textarea}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <AttachFileButton
            onFiles={(files) => ref.current?.attach(files)}
            disabled={sending}
          />
          <UploadStatus pending={uploads.pending} />
        </div>
        {actions}
      </div>
      {dragging && !sending && (
        // Visual only: the drop itself lands on the text or the card beneath.
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary/40 bg-muted text-sm font-medium text-primary/70">
          <Upload01 size={16} />
          {t("taskBoard.taskDialog.commentDropToAttach")}
        </div>
      )}
    </div>
  );
}
