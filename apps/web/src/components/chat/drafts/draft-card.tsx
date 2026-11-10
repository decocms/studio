import { Link } from "@tanstack/react-router";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { AgentAvatar } from "@/components/agent-icon";
import { useT } from "@/i18n/use-t.ts";
import { useProjectContext } from "@/sdk";
import { useOptionalChatTask } from "../chat-context";
import { type ChatDraft, useChatDraft } from "./use-chat-draft";
import { WorkCard } from "../work-card";

function DraftStatus({ draft }: { draft: ChatDraft }) {
  const t = useT();
  return (
    <>
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          draft.editing ? "animate-pulse bg-warning" : "bg-success",
        )}
      />
      {t(draft.editing ? "chat.draft.editing" : "chat.draft.ready")}
    </>
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
    <WorkCard
      className="mx-2.5 mb-6"
      icon={
        <AgentAvatar
          icon={draft.projectIcon}
          name={draft.projectTitle}
          size="sm"
        />
      }
      title={draft.projectTitle}
      subtitle={<span className="font-mono">{draft.branch}</span>}
      status={<DraftStatus draft={draft} />}
      detail={t(
        draft.changeCount === 1 ? "chat.draft.change" : "chat.draft.changes",
        { count: draft.changeCount },
      )}
      action={<OpenDraftButton draft={draft} />}
    />
  );
}
