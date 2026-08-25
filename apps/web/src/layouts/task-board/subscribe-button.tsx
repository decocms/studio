/**
 * Follow a task: the toggle, plus stacked avatars of everyone already
 * following. Sits to the right of the Activity section header in the task
 * dialog.
 *
 * Following means both channels at once — the update lands in your inbox and in
 * your next email digest. One toggle, because "inbox but not email" is a
 * preference nobody asked for yet and unsubscribing already covers "neither".
 */

import { Avatar } from "@decocms/ui/components/avatar.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { getInitials } from "@/lib/get-initials";
import { useTaskSubscription } from "@/hooks/use-task-subscription";
import { useT } from "@/i18n/use-t.ts";
import { authClient } from "@/lib/auth-client";
import type { Member } from "./config";

/** Beyond this the stack stops reading as faces and starts reading as noise. */
const MAX_AVATARS = 3;

export function SubscribeToggle({
  itemId,
  members,
}: {
  itemId: string | undefined;
  /** The org's members, which the follower ids resolve against. */
  members: Member[];
}) {
  const t = useT();
  const { data: session } = authClient.useSession();
  const myUserId = session?.user?.id;
  const { subscriberIds, setSubscribed } = useTaskSubscription(itemId);
  const subscribed = !!myUserId && subscriberIds.includes(myUserId);

  const memberByUserId = new Map(members.map((m) => [m.userId, m]));
  const me = myUserId ? memberByUserId.get(myUserId) : undefined;
  const others = subscriberIds
    .filter((id) => id !== myUserId)
    .map((id) => memberByUserId.get(id))
    .filter((m): m is Member => !!m);

  // Subscribing puts you at the front of the stack.
  const subscribers = [...(subscribed && me ? [me] : []), ...others];
  const shown = subscribers.slice(0, MAX_AVATARS);
  const overflow = subscribers.length - shown.length;

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={!itemId || setSubscribed.isPending}
        onClick={() => setSubscribed.mutate(!subscribed)}
        className="h-7 px-2 text-sm font-normal text-muted-foreground"
      >
        {subscribed
          ? t("taskBoard.taskDialog.unsubscribe")
          : t("taskBoard.taskDialog.subscribe")}
      </Button>
      {shown.length > 0 && (
        <span
          className="inline-flex items-center"
          title={subscribers
            .map((m) => m.user?.name ?? t("taskBoard.taskDialog.someoneLabel"))
            .join(", ")}
        >
          {shown.map((member) => (
            <Avatar
              key={member.userId}
              url={member.user?.image ?? undefined}
              fallback={getInitials(member.user?.name)}
              shape="circle"
              size="xs"
              className="-ml-2 ring-2 ring-background first:ml-0"
            />
          ))}
          {overflow > 0 && (
            <span className="-ml-2 inline-flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground ring-2 ring-background">
              +{overflow}
            </span>
          )}
        </span>
      )}
    </div>
  );
}
