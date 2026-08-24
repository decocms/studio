/**
 * One unread task update in the inbox: who did what, on which card, when.
 *
 * Deliberately terser than the task dialog's timeline — the dialog renders
 * chips inside a sentence, this is a scannable row whose only job is to get you
 * to the card.
 */

import { ChevronRight } from "@untitledui/icons";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import { SuperAgentIcon } from "@/components/super-agent-icon";
import { getInitials } from "@/lib/get-initials";
import { formatTimeAgo } from "@/lib/format-time";
import { taskKey } from "@decocms/shared/task-key";
import { useT } from "@/i18n/use-t.ts";
import type { InboxTaskUpdate } from "@/hooks/use-inbox-feed";
import type { Member } from "@/layouts/task-board/config";

/** The activity actions worth a distinct line here. Anything else reads as a
 *  generic "updated" — the card itself carries the detail. */
function summarize(
  update: InboxTaskUpdate,
  t: ReturnType<typeof useT>,
): string {
  switch (update.action) {
    case "commented":
      return t("sidebar.inbox.actionCommented");
    case "created":
      return t("sidebar.inbox.actionCreated");
    case "status_changed":
      return t("sidebar.inbox.actionStatusChanged");
    case "assignee_changed":
      return t("sidebar.inbox.actionAssigneeChanged");
    case "review_approved":
      return t("sidebar.inbox.actionReviewApproved");
    case "review_changes_requested":
      return t("sidebar.inbox.actionReviewChangesRequested");
    case "review_requested":
      return t("sidebar.inbox.actionReviewRequested");
    case "merge_failed":
      return t("sidebar.inbox.actionMergeFailed");
    default:
      return t("sidebar.inbox.actionUpdated");
  }
}

export function InboxTaskItem({
  update,
  orgSlug,
  actor,
  onSelect,
}: {
  update: InboxTaskUpdate;
  orgSlug: string;
  /** Resolved from the org's members; absent for the agent or a departed one. */
  actor?: Member;
  onSelect: () => void;
}) {
  const t = useT();
  const key = taskKey(orgSlug, update.taskKeySeq);
  const isAgent = !update.actorId;

  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left transition-colors last:border-0 hover:bg-muted/25"
    >
      {isAgent ? (
        <SuperAgentIcon size={24} className="shrink-0" />
      ) : (
        <Avatar
          url={actor?.user?.image ?? undefined}
          fallback={getInitials(actor?.user?.name)}
          shape="circle"
          size="sm"
          className="shrink-0"
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-muted-foreground">
          {key ? `${key} · ` : ""}
          {update.taskTitle}
        </p>
        <p className="truncate text-sm font-medium text-foreground">
          {summarize(update, t)}
        </p>
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">
        {formatTimeAgo(new Date(update.occurredAt))}
      </span>
      <ChevronRight size={16} className="shrink-0 text-muted-foreground" />
    </button>
  );
}
