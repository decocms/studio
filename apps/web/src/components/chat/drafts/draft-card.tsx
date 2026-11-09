import { Link } from "@tanstack/react-router";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { AgentAvatar } from "@/components/agent-icon";
import { useT } from "@/i18n/use-t.ts";
import { useProjectContext } from "@/sdk";
import { useOptionalChatStream, useOptionalChatTask } from "../chat-context";
import { type ChatDraft, useChatDraft } from "./use-chat-draft";

const CARD_ID = "chat-draft-card";

function DraftStatus({ draft }: { draft: ChatDraft }) {
  const t = useT();
  return (
    <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          draft.editing ? "animate-pulse bg-warning" : "bg-success",
        )}
      />
      {t(draft.editing ? "chat.draft.editing" : "chat.draft.ready")}
    </span>
  );
}

function OpenDraftButton({ draft }: { draft: ChatDraft }) {
  const t = useT();
  const { org } = useProjectContext();
  const taskId = useOptionalChatTask()?.taskId ?? null;
  return (
    <Button variant="outline" size="sm" asChild>
      <Link
        to="/$org/projects/$agentId/site-editor"
        params={{ org: org.slug, agentId: draft.virtualMcpId }}
        search={taskId ? { thread: taskId } : {}}
      >
        {t("chat.draft.open")}
      </Link>
    </Button>
  );
}

/** The draft this chat changed, shown in the conversation where the work began. */
export function ChatDraftCard() {
  const t = useT();
  const draft = useChatDraft();
  if (!draft) return null;
  return (
    <div
      id={CARD_ID}
      className="mx-2.5 mb-6 scroll-mt-4 rounded-xl border border-border bg-card p-3"
    >
      <div className="flex items-center gap-2.5">
        <AgentAvatar
          icon={draft.projectIcon}
          name={draft.projectTitle}
          size="sm"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {draft.projectTitle}
          </p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {draft.branch}
          </p>
        </div>
        <DraftStatus draft={draft} />
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-sm text-muted-foreground">
          {t(
            draft.changeCount === 1
              ? "chat.draft.change"
              : "chat.draft.changes",
            { count: draft.changeCount },
          )}
        </span>
        <OpenDraftButton draft={draft} />
      </div>
    </div>
  );
}

/** Keeps a pending draft in reach once its card scrolls away. */
export function PendingDraftStrip() {
  const t = useT();
  const draft = useChatDraft();
  const messages = useOptionalChatStream()?.messages ?? [];
  // An empty chat shows the card itself right above the composer.
  if (!draft || messages.length === 0) return null;
  return (
    <button
      type="button"
      onClick={() =>
        document
          .getElementById(CARD_ID)
          ?.scrollIntoView({ behavior: "smooth", block: "start" })
      }
      className="mx-auto mb-2 flex max-w-full items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          draft.editing ? "animate-pulse bg-warning" : "bg-success",
        )}
      />
      <span className="truncate">
        {t("chat.draft.pending", { project: draft.projectTitle })}
      </span>
    </button>
  );
}
