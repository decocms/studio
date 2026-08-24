/**
 * Follow a task: stacked avatars of everyone already following, plus the
 * toggle. Sits to the right of the Activity section header in the task dialog.
 *
 * Following means both channels at once — the update lands in your inbox and in
 * your next email digest. One toggle, because "inbox but not email" is a
 * preference nobody asked for yet and unsubscribing already covers "neither".
 */

import { Bell01, BellOff01 } from "@untitledui/icons";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { getInitials } from "@/lib/get-initials";
import { useT } from "@/i18n/use-t.ts";
import { useOrgFlag } from "@/hooks/use-organization-settings";
import { useTaskBoardSubscription } from "@/hooks/use-task-board-subscription";
import type { Member } from "./config";

/** Beyond this the stack stops reading as faces and starts reading as noise. */
const MAX_AVATARS = 3;

export function SubscribeToggle({
  itemId,
  members,
}: {
  itemId: string;
  members: Member[];
}) {
  const t = useT();
  // No flag, no inbox and no digest — the toggle would promise nothing.
  const enabled = useOrgFlag("task_notifications");
  const { subscriberIds, isSubscribed, isLoading, toggle } =
    useTaskBoardSubscription(enabled ? itemId : undefined);
  const memberByUserId = new Map(members.map((m) => [m.userId, m]));
  if (!enabled) return null;

  const shown = subscriberIds.slice(0, MAX_AVATARS);
  const overflow = subscriberIds.length - shown.length;

  return (
    <div className="flex items-center gap-2">
      {shown.length > 0 && (
        <span
          className="inline-flex items-center"
          title={subscriberIds
            .map(
              (id) =>
                memberByUserId.get(id)?.user?.name ??
                t("taskBoard.taskDialog.someoneLabel"),
            )
            .join(", ")}
        >
          {shown.map((id) => {
            const member = memberByUserId.get(id);
            return (
              <Avatar
                key={id}
                url={member?.user?.image ?? undefined}
                fallback={getInitials(member?.user?.name)}
                shape="circle"
                size="xs"
                className="-mr-2 ring-2 ring-background last:mr-0"
              />
            );
          })}
          {overflow > 0 && (
            <span className="inline-flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground ring-2 ring-background">
              +{overflow}
            </span>
          )}
        </span>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={isLoading}
        onClick={toggle}
        className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
      >
        {isSubscribed ? <BellOff01 size={14} /> : <Bell01 size={14} />}
        {isSubscribed
          ? t("taskBoard.taskDialog.unsubscribe")
          : t("taskBoard.taskDialog.subscribe")}
      </Button>
    </div>
  );
}
