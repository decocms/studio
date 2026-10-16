/**
 * Comments on a task — threads inside the activity feed, with one level of
 * replies, a reply field per thread and a shared composer.
 *
 * A thread can be a Super Agent run: the comment that started it (or the
 * agent's own comment from it) carries the run, and replying in the thread is
 * talking to that run.
 *
 * Presentation only: the data and the mutations come from
 * `useTaskBoardComments`, and the dialog maps a comment's `authorId` to a
 * member before handing it here.
 *
 * Tiptap, not a textarea: a mention and an attachment both render as a chip.
 */

import {
  Fragment,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import {
  AlertCircle,
  ArrowUp,
  CheckCircle,
  DotsHorizontal,
  Edit03,
  MessageTextSquare01,
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
import type { MentionAgent } from "@/components/markdown-editor/mention-suggestion";
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
  /** The Super Agent run this thread is, on a root comment. */
  run?: CommentRun;
};

export type CommentRun = {
  status: "running" | "waiting" | "done" | "failed";
  onOpen?: () => void;
};

/**
 * Where a message for the Super Agent goes: a new run, the run in progress,
 * a finished run picked up again, or nowhere while another run works the
 * card (one run at a time).
 */
export type AgentRoute = "start" | "steer" | "revive" | "busy";

/** The Super Agent in the `@` picker, above the members. */
function useAgentMentions(): MentionAgent[] {
  const t = useT();
  return [
    {
      id: SUPER_AGENT_ASSIGNEE_ID,
      name: t("taskBoard.taskDialog.superAgentLabel"),
      icon: <SuperAgentIcon size={20} />,
    },
  ];
}

/**
 * A comment thread: the root comment and its existing replies.
 */
export function CommentThreadCard({
  thread,
  me,
  onEdit,
  onDelete,
  onReply,
  liveRunElsewhere,
}: {
  thread: TaskComment;
  me: CommentAuthor;
  /** False keeps the editor open, so a failed save doesn't lose the edit. */
  onEdit: (commentId: string, body: string) => Promise<boolean>;
  /** `commentId` is the thread root's id when the root itself is deleted. */
  onDelete: (commentId: string) => void;
  /** Posts a reply under this thread's root. */
  onReply?: SubmitComment;
  /** A run other than this thread's is working the card. */
  liveRunElsewhere?: boolean;
}) {
  const t = useT();
  const [replying, setReplying] = useState(false);
  const live =
    thread.run?.status === "running" || thread.run?.status === "waiting";
  // Replying in a run's thread is talking to the run, @ or not.
  const replyRoute: AgentRoute | undefined = thread.run
    ? live
      ? "steer"
      : liveRunElsewhere
        ? "busy"
        : "revive"
    : undefined;

  return (
    <div className={cn("flex flex-col", "border-b border-border/50 pb-4")}>
      <CommentEntry
        comment={thread}
        metadata={thread.run && <RunStatus run={thread.run} />}
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
      {onReply &&
        (replying ? (
          <div className="ml-11 mt-2">
            <CommentComposer
              compact
              autoFocus
              placeholder={t(
                thread.run
                  ? "taskBoard.agentThread.replyToRunPlaceholder"
                  : "taskBoard.taskDialog.commentReplyPlaceholder",
              )}
              route={replyRoute}
              mentionRoute={liveRunElsewhere ? "steer" : "start"}
              onCancel={() => setReplying(false)}
              onSubmit={async (body) => {
                const sent = await onReply(body);
                if (sent !== false) setReplying(false);
                return sent;
              }}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setReplying(true)}
            className="ml-11 mt-1 flex w-fit cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <MessageTextSquare01 size={14} />
            {t(
              replyRoute === "steer"
                ? "taskBoard.agentThread.replySteer"
                : replyRoute === "revive"
                  ? "taskBoard.agentThread.replyRevive"
                  : "taskBoard.agentThread.reply",
            )}
          </button>
        ))}
    </div>
  );
}

/** The run's state beside the comment that started it. */
function RunStatus({ run }: { run: CommentRun }) {
  const t = useT();
  const chip = cn(
    "flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
  );
  const body =
    run.status === "running" ? (
      <span className={cn(chip, "bg-success/10 text-success")}>
        <Spinner size="xs" />
        {t("taskBoard.agentThread.statusRunning")}
      </span>
    ) : run.status === "waiting" ? (
      <span className={cn(chip, "bg-warning/15 text-warning")}>
        <AlertCircle size={12} />
        {t("taskBoard.agentThread.statusWaiting")}
      </span>
    ) : run.status === "failed" ? (
      <span className={cn(chip, "bg-destructive/10 text-destructive")}>
        <AlertCircle size={12} />
        {t("taskBoard.agentThread.statusFailed")}
      </span>
    ) : (
      <span className={cn(chip, "bg-muted text-muted-foreground")}>
        <CheckCircle size={12} />
        {t("taskBoard.agentThread.statusDone")}
      </span>
    );
  return run.onOpen ? (
    <button
      type="button"
      onClick={run.onOpen}
      className="cursor-pointer rounded-full transition-opacity hover:opacity-80"
      aria-label={t("taskBoard.agentThread.openRun")}
    >
      {body}
    </button>
  ) : (
    body
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
  metadata,
  onEdit,
  onDelete,
}: {
  comment: TaskComment;
  isReply?: boolean;
  metadata?: ReactNode;
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
      metadata={metadata}
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

export function NewCommentComposer({
  onSubmit,
  agentRoute,
}: {
  onSubmit: SubmitComment;
  /** Where an `@Super Agent` written here goes. */
  agentRoute: "start" | "steer";
}) {
  return <CommentComposer onSubmit={onSubmit} mentionRoute={agentRoute} />;
}

/** What the composer says about a message for the Super Agent, above the
 *  text, while the field wears the agent's outline. */
function AgentRouteNote({ route }: { route: AgentRoute }) {
  const t = useT();
  return (
    <div
      data-testid="agent-route-note"
      className={cn(
        "flex items-start gap-2 text-xs",
        route === "busy" ? "text-muted-foreground" : "text-success",
      )}
    >
      <SuperAgentIcon size={16} />
      <span className="leading-4">
        {t(
          route === "start"
            ? "taskBoard.agentThread.routeStart"
            : route === "steer"
              ? "taskBoard.agentThread.routeSteer"
              : route === "revive"
                ? "taskBoard.agentThread.routeRevive"
                : "taskBoard.agentThread.routeBusy",
        )}
      </span>
    </div>
  );
}

/** Only an OS file drag; a text or chip dragged inside the field is a move. */
function carriesFiles(e: DragEvent) {
  return e.dataTransfer.types.includes("Files");
}

function CommentComposer({
  onSubmit,
  route,
  mentionRoute,
  placeholder,
  compact,
  autoFocus,
  onCancel,
}: {
  onSubmit: SubmitComment;
  /** Where every message from this field goes (a reply in a run's thread). */
  route?: AgentRoute;
  /** Where a message that mentions the Super Agent goes. */
  mentionRoute?: AgentRoute;
  placeholder?: string;
  /** A reply field inside a thread rather than the page's composer. */
  compact?: boolean;
  autoFocus?: boolean;
  onCancel?: () => void;
}) {
  const t = useT();
  const ref = useRef<MentionInputHandle>(null);
  const agents = useAgentMentions();
  const [mentionsAgent, setMentionsAgent] = useState(false);
  const agentRoute = route ?? (mentionsAgent ? mentionRoute : undefined);
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
      placeholder={placeholder ?? t("taskBoard.taskDialog.commentPlaceholder")}
      onSubmit={onSubmit}
      onEmptyChange={setEmpty}
      onSendingChange={setSending}
      onMentionsChange={(ids) =>
        setMentionsAgent(ids.includes(SUPER_AGENT_ASSIGNEE_ID))
      }
      agents={agents}
      autoFocus={autoFocus}
      uploads={uploads}
      // A full-height screenshot would push the conversation out of the way; the posted comment shows it whole.
      className={cn(
        "w-full [&_.tiptap]:outline-none",
        compact ? "min-h-6" : "min-h-10",
        "[&_img]:max-h-40",
      )}
    />
  );

  const actions = (
    <button
      type="button"
      disabled={empty || uploads.pending > 0 || agentRoute === "busy"}
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
      data-agent-route={agentRoute}
      className={cn(
        "relative flex cursor-text flex-col gap-1 rounded-xl bg-card card-shadow transition-shadow",
        compact ? "p-2" : "p-3",
        // An outline, not a ring: `card-shadow` owns the box-shadow a ring draws with.
        agentRoute &&
          agentRoute !== "busy" &&
          "outline-2 outline-offset-2 outline-success/60",
        agentRoute === "busy" && "outline-1 outline-border",
      )}
    >
      {agentRoute && <AgentRouteNote route={agentRoute} />}
      {textarea}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <AttachFileButton
            onFiles={(files) => ref.current?.attach(files)}
            disabled={sending}
          />
          <UploadStatus pending={uploads.pending} />
        </div>
        <div className="flex items-center gap-1">
          {onCancel && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-muted-foreground"
              onClick={(e) => {
                e.stopPropagation();
                onCancel();
              }}
            >
              {t("taskBoard.taskDialog.commentEditCancel")}
            </Button>
          )}
          {actions}
        </div>
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
