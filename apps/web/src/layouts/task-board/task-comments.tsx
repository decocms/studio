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

import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import { Badge } from "@decocms/ui/components/badge.tsx";
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
  ChevronUp,
  CornerUpLeft,
  DotsHorizontal,
  Edit03,
  MessageTextSquare01,
  MinusCircle,
  Trash03,
  Upload01,
} from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import { SuperAgentIcon } from "@/components/super-agent-icon";
import { ReviewerIcon } from "@/components/reviewer-icon";
import { openOnRowClick, TaskMessage } from "./task-message";
import { useT, type TranslationKey } from "@/i18n/use-t.ts";
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
  threadId?: string | null;
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
  status: "running" | "waiting" | "done" | "failed" | "stopped";
  onOpen?: () => void;
  /** Stops the run in progress. Resolves once the stop is requested; the run
   *  reads as stopped when the card next refreshes. */
  onStop?: () => Promise<void>;
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
      icon: <SuperAgentIcon size={24} />,
    },
  ];
}

/** A comment thread as a chat: the root, then its replies indented under it. */
export function CommentThreadCard({
  thread,
  me,
  onEdit,
  onDelete,
  onReply,
  liveRunElsewhere,
  continuation,
  replying: replyingProp,
  onReplyingChange,
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
  /** The same person's previous message sits right above this one. */
  continuation?: boolean;
  /** Controlled reply field, so the feed keeps one open at a time. */
  replying?: boolean;
  onReplyingChange?: (open: boolean) => void;
}) {
  const t = useT();
  const [ownReplying, setOwnReplying] = useState(false);
  const replying = replyingProp ?? ownReplying;
  const setReplying = onReplyingChange ?? setOwnReplying;
  const live =
    thread.run?.status === "running" || thread.run?.status === "waiting";
  // A finished run's thread opens folded to the comment that started it; the
  // live one, and a plain comment's, stay open.
  const [expanded, setExpanded] = useState(
    !thread.run || live || thread.replies.length === 0,
  );
  const lastReply = thread.replies.at(-1);
  // Replying in a run's thread is talking to the run, @ or not.
  const replyRoute: AgentRoute | undefined = thread.run
    ? live
      ? "steer"
      : liveRunElsewhere
        ? "busy"
        : "revive"
    : undefined;
  const replyLabel = t(
    replyRoute === "steer"
      ? "taskBoard.agentThread.replySteer"
      : replyRoute === "revive"
        ? "taskBoard.agentThread.replyRevive"
        : "taskBoard.agentThread.reply",
  );
  const startReply = () => {
    setExpanded(true);
    setReplying(true);
  };
  const showHide =
    expanded && !!thread.run && thread.replies.length > 0 && !live;
  // The agent shows the run's state, never the person who called it.
  const run = thread.run;
  const runOnRoot = run && thread.author.isAgent ? run : undefined;
  const runOnLastReply =
    run && !runOnRoot && expanded && lastReply?.author.isAgent
      ? run
      : undefined;
  const runOnOwnLine = run && !runOnRoot && !runOnLastReply ? run : undefined;
  const runMetadata = (shown: CommentRun) => (
    <>
      <RunStatus run={shown} />
      {live && shown.onStop && <StopRunButton onStop={shown.onStop} />}
    </>
  );

  return (
    <div
      data-testid="comment-thread"
      data-expanded={expanded}
      className={cn("flex flex-col", !continuation && "pt-2")}
    >
      <CommentEntry
        comment={thread}
        onOpen={
          thread.author.isAgent
            ? (thread.run?.onOpen ?? thread.onOpenThread)
            : undefined
        }
        continuation={continuation}
        metadata={runOnRoot && runMetadata(runOnRoot)}
        onReply={onReply && startReply}
        replyLabel={replyLabel}
        onEdit={
          canEdit(thread, me) ? (body) => onEdit(thread.id, body) : undefined
        }
        onDelete={canDelete(thread, me) ? () => onDelete(thread.id) : undefined}
      />
      {(thread.replies.length > 0 || replying || runOnOwnLine) && (
        <div className="ml-11 flex flex-col">
          {!expanded && lastReply && (
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="focus-ring -mx-1.5 flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left text-sm transition-colors hover:bg-muted/50"
              >
                <ReplierFaces replies={thread.replies} />
                <span className="shrink-0 font-medium text-foreground">
                  {thread.replies.length === 1
                    ? t("taskBoard.agentThread.repliesCountOne")
                    : t("taskBoard.agentThread.repliesCount", {
                        count: thread.replies.length,
                      })}
                </span>
                <span className="min-w-0 truncate text-muted-foreground">
                  {lastReply.author.name}: {plainExcerpt(lastReply.body)}
                </span>
              </button>
              {runOnOwnLine && !live && <RunStatus run={runOnOwnLine} />}
            </div>
          )}
          {expanded &&
            thread.replies.map((reply, i) => (
              <CommentEntry
                key={reply.id}
                onOpen={
                  reply.author.isAgent
                    ? (reply.onOpenThread ?? thread.run?.onOpen)
                    : undefined
                }
                // The run's status opens it; no second button for the same thing.
                comment={
                  runOnLastReply && reply === lastReply
                    ? { ...reply, onOpenThread: undefined }
                    : reply
                }
                metadata={
                  runOnLastReply &&
                  reply === lastReply &&
                  runMetadata(runOnLastReply)
                }
                continuation={isContinuation(thread.replies[i - 1], reply)}
                onEdit={
                  canEdit(reply, me)
                    ? (body) => onEdit(reply.id, body)
                    : undefined
                }
                onDelete={
                  canDelete(reply, me) ? () => onDelete(reply.id) : undefined
                }
                onReply={onReply && startReply}
                replyLabel={replyLabel}
                isReply
              />
            ))}
          {runOnOwnLine && (live || expanded) && (
            <div
              onClick={
                runOnOwnLine.onOpen && openOnRowClick(runOnOwnLine.onOpen)
              }
              className={cn(
                "-mx-3 flex min-h-9 items-center gap-3 rounded-lg px-3 py-1 transition-colors",
                runOnOwnLine.onOpen && "cursor-pointer hover:bg-muted/50",
              )}
            >
              <div className="flex w-8 shrink-0 justify-center">
                <SuperAgentIcon size={24} />
              </div>
              <span className="text-sm font-medium text-foreground">
                {t("taskBoard.taskDialog.superAgentLabel")}
              </span>
              {runMetadata(runOnOwnLine)}
            </div>
          )}
          {onReply && replying && (
            <div className="mt-1">
              <CommentComposer
                autoFocus
                replyTo={
                  thread.run
                    ? {
                        id: SUPER_AGENT_ASSIGNEE_ID,
                        name: t("taskBoard.taskDialog.superAgentLabel"),
                        isAgent: true,
                      }
                    : thread.author
                }
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
          )}
          {showHide && (
            <div className="-mx-2 flex">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  setExpanded(false);
                  setReplying(false);
                }}
                className="font-normal text-muted-foreground"
              >
                <ChevronUp />
                {t("taskBoard.agentThread.hideReplies")}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Up to three distinct repliers, overlapped, on a folded thread. */
function ReplierFaces({ replies }: { replies: TaskComment[] }) {
  const authors = [
    ...new Map(
      replies.map((reply) => [reply.author.id, reply.author]),
    ).values(),
  ].slice(0, 3);
  return (
    <span className="flex shrink-0 -space-x-1">
      {authors.map((author) => (
        <span
          key={author.id}
          className="flex rounded-full ring-2 ring-background"
        >
          <AuthorGlyph author={author} size="2xs" />
        </span>
      ))}
    </span>
  );
}

/** Messages a few minutes apart from the same person read as one turn. */
const CONTINUATION_WINDOW_MS = 5 * 60_000;

/**
 * Whether `next` continues `previous`'s turn: same author, minutes apart, and
 * neither one a run (a run's badge needs its header) or a thread with replies
 * between them.
 */
export function isContinuation(
  previous: TaskComment | undefined,
  next: TaskComment,
): boolean {
  if (!previous || previous.replies.length > 0) return false;
  if (previous.run || next.run) return false;
  if (previous.author.id !== next.author.id) return false;
  if (!!previous.internal !== !!next.internal) return false;
  const gap =
    new Date(next.createdAt).getTime() - new Date(previous.createdAt).getTime();
  return gap >= 0 && gap < CONTINUATION_WINDOW_MS;
}

/** Stops the run in progress. Stays "Stopping…" until the run reads as
 *  stopped; a refused stop puts the button back. */
function StopRunButton({ onStop }: { onStop: () => Promise<void> }) {
  const t = useT();
  const [stopping, setStopping] = useState(false);
  return (
    <Button
      variant="ghost-destructive"
      size="xs"
      disabled={stopping}
      onClick={async () => {
        setStopping(true);
        try {
          await onStop();
        } catch {
          setStopping(false);
        }
      }}
      className="h-5"
    >
      {stopping ? (
        <Spinner size="2xs" />
      ) : (
        // A solid square, the media-player stop, rather than an outlined glyph.
        <span aria-hidden className="size-2 rounded-[2px] bg-current" />
      )}
      {t(
        stopping
          ? "taskBoard.agentThread.stopping"
          : "taskBoard.agentThread.stop",
      )}
    </Button>
  );
}

/** One line of a markdown body, for a folded thread: mentions and links
 *  read as their text, and the markup goes. */
function plainExcerpt(markdown: string): string {
  return markdown
    .replace(/\[@?([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** How each run state reads: a status badge, its glyph, its label. */
function runStatusBadge(status: CommentRun["status"]): {
  variant: "success" | "warning" | "destructive" | "muted";
  /** `[a&]:hover` in the badge only covers links; the status opens the run. */
  hover: string;
  icon: ReactNode;
  label: TranslationKey;
} {
  switch (status) {
    case "running":
      return {
        variant: "success",
        hover: "hover:bg-success/15",
        icon: <Spinner size="2xs" />,
        label: "taskBoard.agentThread.statusRunning",
      };
    case "waiting":
      return {
        variant: "warning",
        hover: "hover:bg-warning/15",
        icon: <AlertCircle />,
        label: "taskBoard.agentThread.statusWaiting",
      };
    case "failed":
      return {
        variant: "destructive",
        hover: "hover:bg-destructive/15",
        icon: <AlertCircle />,
        label: "taskBoard.agentThread.statusFailed",
      };
    case "stopped":
      return {
        variant: "muted",
        hover: "hover:bg-secondary-hover",
        icon: <MinusCircle />,
        label: "taskBoard.agentThread.statusStopped",
      };
    case "done":
      return {
        variant: "muted",
        hover: "hover:bg-secondary-hover",
        icon: <CheckCircle />,
        label: "taskBoard.agentThread.statusDone",
      };
    default: {
      const unhandled: never = status;
      throw new Error(`Unhandled run status: ${String(unhandled)}`);
    }
  }
}

/** The run's state beside the comment that started it. */
function RunStatus({ run }: { run: CommentRun }) {
  const t = useT();
  const { variant, hover, icon, label } = runStatusBadge(run.status);
  return run.onOpen ? (
    <Badge variant={variant} asChild className={cn("cursor-pointer", hover)}>
      <button
        type="button"
        onClick={run.onOpen}
        aria-label={t("taskBoard.agentThread.openRun")}
      >
        {icon}
        {t(label)}
      </button>
    </Badge>
  ) : (
    <Badge variant={variant}>
      {icon}
      {t(label)}
    </Badge>
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

/** One comment as a chat line, with Reply and edit/delete in its hover toolbar. */
function CommentEntry({
  comment,
  onOpen,
  isReply,
  continuation,
  metadata,
  onReply,
  replyLabel,
  onEdit,
  onDelete,
}: {
  comment: TaskComment;
  /** The whole message opens the agent's chat. */
  onOpen?: () => void;
  isReply?: boolean;
  continuation?: boolean;
  metadata?: ReactNode;
  onReply?: () => void;
  replyLabel?: string;
  onEdit?: (body: string) => Promise<boolean>;
  /** Omitted for a comment that isn't the current user's — the server
   *  rejects deleting someone else's comment, so don't offer it. */
  onDelete?: () => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);

  return (
    <TaskMessage
      id={comment.id}
      commentId={comment.id}
      author={comment.author.name}
      avatar={
        <AuthorGlyph author={comment.author} size={isReply ? "xs" : "sm"} />
      }
      createdAt={comment.createdAt}
      body={comment.body}
      threadId={comment.threadId}
      continuation={continuation && !metadata}
      metadata={metadata}
      muted={comment.internal}
      onOpenThread={comment.onOpenThread}
      onOpen={editing ? undefined : onOpen}
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
        (onReply || onEdit || onDelete) && (
          <>
            {onReply && (
              <Button
                variant="ghost"
                size="sm"
                title={replyLabel}
                onClick={onReply}
                className="font-normal text-muted-foreground"
              >
                <MessageTextSquare01 size={16} />
                {t("taskBoard.agentThread.reply")}
              </Button>
            )}
            {(onEdit || onDelete) && (
              <CommentActionsMenu
                onEdit={onEdit && (() => setEditing(true))}
                onDelete={onDelete}
              />
            )}
          </>
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
    <div className="surface flex flex-col gap-1 p-3">
      <MarkdownEditor
        inline
        defaultValue={body}
        onChange={setDraft}
        placeholder={t("taskBoard.taskDialog.commentPlaceholder")}
      />
      <div className="flex justify-end gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          disabled={saving}
          className="text-muted-foreground"
        >
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

/** Per-comment overflow menu; the toolbar stays up while it's open. */
function CommentActionsMenu({
  onEdit,
  onDelete,
}: {
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const t = useT();
  const closedByPointer = useRef(false);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("taskBoard.taskDialog.commentActionsAriaLabel")}
          className="shrink-0 text-muted-foreground"
        >
          <DotsHorizontal size={16} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-48"
        onPointerDownOutside={() => {
          closedByPointer.current = true;
        }}
        onPointerUp={() => {
          closedByPointer.current = true;
        }}
        // Focus returned after a mouse close reads as keyboard focus and pins the hover toolbar open.
        onCloseAutoFocus={(event) => {
          if (closedByPointer.current) event.preventDefault();
          closedByPointer.current = false;
        }}
      >
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

function AuthorGlyph({
  author,
  size,
}: {
  author: CommentAuthor;
  size: "2xs" | "xs" | "sm";
}) {
  const px = { "2xs": 16, xs: 24, sm: 32 }[size];
  if (author.isReviewer) return <ReviewerIcon size={px} />;
  if (author.isAgent) return <SuperAgentIcon size={px} />;
  return (
    <Avatar
      url={author.image ?? undefined}
      fallback={author.name ?? "?"}
      shape="circle"
      size={size}
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
  placeholder,
  compact = false,
  trailingActions,
}: {
  onSubmit: SubmitComment;
  /** Where an `@Super Agent` written here goes. */
  agentRoute?: "start" | "steer";
  placeholder?: string;
  compact?: boolean;
  trailingActions?: ReactNode;
}) {
  return (
    <CommentComposer
      onSubmit={onSubmit}
      mentionRoute={agentRoute}
      placeholder={placeholder}
      compact={compact}
      trailingActions={trailingActions}
    />
  );
}

/** Above the text: who a reply answers, and where a message for the Super Agent goes. */
function ComposerHeader({
  replyTo,
  route,
}: {
  replyTo?: CommentAuthor;
  route?: AgentRoute;
}) {
  const t = useT();
  const busy = route === "busy";
  return (
    <div
      data-testid={route ? "agent-route-note" : undefined}
      className={cn(
        "-mx-3 -mt-3 mb-1 flex items-center gap-2 border-b border-border/60 px-3 py-2 text-xs font-medium",
        busy ? "text-warning" : route ? "text-success" : "text-foreground",
      )}
    >
      {replyTo && (
        <CornerUpLeft size={14} className="shrink-0 text-muted-foreground" />
      )}
      {replyTo ? (
        <AuthorGlyph author={replyTo} size="2xs" />
      ) : busy ? (
        <AlertCircle size={14} className="shrink-0" />
      ) : (
        <SuperAgentIcon size={16} />
      )}
      <span className="min-w-0 truncate">
        {route
          ? t(
              route === "start"
                ? "taskBoard.agentThread.routeStart"
                : route === "steer"
                  ? "taskBoard.agentThread.routeSteer"
                  : route === "revive"
                    ? "taskBoard.agentThread.routeRevive"
                    : "taskBoard.agentThread.routeBusy",
            )
          : replyTo?.name}
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
  replyTo,
  route,
  mentionRoute,
  placeholder,
  compact = false,
  trailingActions,
  autoFocus,
  onCancel,
}: {
  onSubmit: SubmitComment;
  /** Where every message from this field goes (a reply in a run's thread). */
  route?: AgentRoute;
  /** Where a message that mentions the Super Agent goes. */
  mentionRoute?: AgentRoute;
  placeholder?: string;
  compact?: boolean;
  trailingActions?: ReactNode;
  /** Who a reply answers, shown above the text. */
  replyTo?: CommentAuthor;
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
        compact
          ? "min-w-0 max-h-28 overflow-y-auto [&_.tiptap]:min-h-6"
          : "min-h-10",
        "[&_img]:max-h-40",
      )}
    />
  );

  const actions = (
    <Button
      variant="ghost"
      size="icon-sm"
      disabled={empty || uploads.pending > 0 || agentRoute === "busy"}
      onClick={submit}
      aria-label={t("taskBoard.taskDialog.commentSubmitAriaLabel")}
      // cursor-pointer: the composer around it sets cursor-text, which would
      // otherwise inherit onto the button.
      className="shrink-0 cursor-pointer text-muted-foreground"
    >
      <ArrowUp size={16} />
    </Button>
  );

  // The whole composer is the click target, not just the one-line input inside
  // it: the empty space below "Leave a comment..." reads as part of the field,
  // so clicking it should put
  // the caret there. A click that lands on the send button hits the button
  // first and bubbles here after, which only re-focuses the (now empty)
  // composer.
  const focusInput = () => ref.current?.focus();

  const agentGlow = !!agentRoute && agentRoute !== "busy";

  return (
    <div className="relative">
      {/* The brand's purple, lime and yellow: a glow under the field and its edge. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 top-1/2 -bottom-2 rounded-full bg-gradient-to-r from-brand-purple via-brand to-brand-yellow blur-xl transition-opacity duration-300",
          agentGlow ? "opacity-40 dark:opacity-25" : "opacity-0",
        )}
      />
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute -inset-px rounded-[calc(var(--studio-surface-radius)+1px)] bg-gradient-to-r from-brand-purple via-brand to-brand-yellow transition-opacity duration-300",
          agentGlow ? "opacity-100" : "opacity-0",
        )}
      />
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
          "surface relative cursor-text gap-1 transition-shadow",
          compact
            ? "grid grid-cols-[minmax(0,1fr)_auto] items-center px-3 py-2"
            : "flex flex-col p-3",
          // An outline, not a ring: `surface` owns the box-shadow a ring draws with.
          agentRoute === "busy" && "outline-1 outline-border",
        )}
      >
        {(replyTo || agentRoute) && (
          <div className={cn(compact && "col-span-2 pt-1")}>
            <ComposerHeader replyTo={replyTo} route={agentRoute} />
          </div>
        )}
        {textarea}
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            {!compact && (
              <AttachFileButton
                onFiles={(files) => ref.current?.attach(files)}
                disabled={sending}
              />
            )}
            <UploadStatus pending={uploads.pending} />
          </div>
          <div className="flex items-center gap-1">
            {onCancel && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  onCancel();
                }}
              >
                {t("taskBoard.taskDialog.commentEditCancel")}
              </Button>
            )}
            {trailingActions}
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
    </div>
  );
}
