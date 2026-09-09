/** One inbox row: the card, what changed on it, and when. */

import { Avatar } from "@decocms/ui/components/avatar.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { SuperAgentIcon } from "@/components/super-agent-icon";
import { getInitials } from "@/lib/get-initials";
import { formatTimeAgo } from "@/lib/format-time";
import { taskKey } from "@decocms/shared/task-key";
import { useT } from "@/i18n/use-t.ts";
import type { InboxTaskUpdate } from "@/hooks/use-inbox-feed";

/**
 * The few actions worth a color: the two that need you and the one that is
 * simply good news. Everything else stays muted, or nothing stands out.
 */
function tone(action: InboxTaskUpdate["action"]): string {
  switch (action) {
    case "mentioned":
    case "review_requested":
      return "font-medium text-foreground";
    case "merge_failed":
    case "review_changes_requested":
      return "font-medium text-destructive";
    case "review_approved":
      return "font-medium text-success";
    default:
      return "";
  }
}

/** What changed, in a few words. The card itself carries the detail. */
function summarize(
  update: InboxTaskUpdate,
  t: ReturnType<typeof useT>,
): string {
  switch (update.action) {
    case "commented":
      return t("sidebar.inbox.actionCommented");
    case "mentioned":
      return t("sidebar.inbox.actionMentioned");
    case "created":
      return t("sidebar.inbox.actionCreated");
    case "status_changed":
      return t("sidebar.inbox.actionStatusChanged");
    case "assignee_changed":
      return t("sidebar.inbox.actionAssigneeChanged");
    case "review_requested":
      return t("sidebar.inbox.actionReviewRequested");
    case "review_approved":
      return t("sidebar.inbox.actionReviewApproved");
    case "review_changes_requested":
      return t("sidebar.inbox.actionReviewChangesRequested");
    case "merge_failed":
      return t("sidebar.inbox.actionMergeFailed");
    default: {
      const _exhaustive: never = update.action;
      return String(_exhaustive);
    }
  }
}

export function InboxTaskItem({
  update,
  orgSlug,
  onSelect,
}: {
  update: InboxTaskUpdate;
  orgSlug: string;
  onSelect: () => void;
}) {
  const t = useT();
  const key = taskKey(orgSlug, update.taskKeySeq);
  const isAgent = !update.actorName;

  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-start gap-3 border-b border-border px-4 py-3 text-left transition-colors last:border-0 hover:bg-muted/25"
    >
      <span className="mt-0.5 shrink-0">
        {isAgent ? (
          <SuperAgentIcon size={24} />
        ) : (
          <Avatar
            url={update.actorImage ?? undefined}
            fallback={getInitials(update.actorName ?? undefined)}
            shape="circle"
            // 24px, matching SuperAgentIcon above — `sm` is 32 and read bigger.
            size="xs"
          />
        )}
      </span>
      <div className="min-w-0 flex-1">
        {/* Title and age share a line so the row has a right column to scan. */}
        <div className="flex items-baseline gap-2">
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {update.taskTitle}
          </p>
          <span className="shrink-0 text-xs text-muted-foreground/70">
            {formatTimeAgo(new Date(update.occurredAt))}
          </span>
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {key && (
            <>
              <span className="font-medium">{key}</span>
              {" · "}
            </>
          )}
          <span className={cn(tone(update.action))}>
            {summarize(update, t)}
          </span>
        </p>
      </div>
    </button>
  );
}
