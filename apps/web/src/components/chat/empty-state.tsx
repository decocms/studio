import { usePreferences } from "@/hooks/use-preferences";
import { useT } from "@/i18n/use-t.ts";
import { formatRelativeTime } from "@/lib/format-time";
import { useThreadsPanel } from "@/components/sidebar/task-groups/use-threads-panel";
import type { Task } from "./task/types";
import { useDraftChanges } from "./drafts/use-chat-draft";

const RECENT_LIMIT = 4;

/** A recent chat, marked when its draft still has changes to publish. */
function RecentChatRow({
  thread,
  onSelect,
}: {
  thread: Task;
  onSelect: () => void;
}) {
  const t = useT();
  const [preferences] = usePreferences();
  const { changeCount } = useDraftChanges(
    thread.virtual_mcp_id,
    thread.branch,
    { poll: false },
  );
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-accent"
    >
      <span className="min-w-0 flex-1 truncate text-foreground">
        {thread.title || t("tasksPanel.taskRow.untitledTask")}
      </span>
      {changeCount > 0 && (
        <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
          <span aria-hidden className="size-1.5 rounded-full bg-success" />
          {t("chat.emptyState.draftPending")}
        </span>
      )}
      <span className="shrink-0 text-muted-foreground">
        {formatRelativeTime(new Date(thread.updated_at), preferences.language)}
      </span>
    </button>
  );
}

/** An empty chat picks up where you were: the chats to continue, marking
 *  the ones with a pending draft. With none, one quiet line. */
export function ChatEmptyState() {
  const t = useT();
  const panel = useThreadsPanel();
  const recent = panel.threads
    .filter((thread) => thread.id !== panel.activeTaskId)
    .slice(0, RECENT_LIMIT);

  if (recent.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6">
        <p className="text-sm text-muted-foreground">
          {t("chat.emptyState.start")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col justify-end overflow-y-auto">
      <section className="mx-auto w-full max-w-2xl px-2.5 pb-2">
        <h2 className="px-2 pb-1 text-sm text-muted-foreground">
          {t("chat.emptyState.continue")}
        </h2>
        <ul>
          {recent.map((thread) => (
            <li key={thread.id}>
              <RecentChatRow
                thread={thread}
                onSelect={() => panel.selectTask(thread)}
              />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
