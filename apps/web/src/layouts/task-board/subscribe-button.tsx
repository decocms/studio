/**
 * Follow a task: stacked avatars of everyone already following, plus the
 * toggle. Sits to the right of the Activity section header in the task dialog.
 *
 * Following means both channels at once — the update lands in your inbox and in
 * your next email digest. One toggle, because "inbox but not email" is a
 * preference nobody asked for yet and unsubscribing already covers "neither".
 *
 * DESIGN PREVIEW: the toggle is local state and the starting subscribers are
 * the task's assignee plus the first couple of org members. Wiring this to real
 * subscriptions replaces `useState` with the subscription hook; the markup is
 * final.
 */

import { useState } from "react";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { getInitials } from "@/lib/get-initials";
import { useT } from "@/i18n/use-t.ts";
import { authClient } from "@/lib/auth-client";
import type { Member } from "./config";

/** Beyond this the stack stops reading as faces and starts reading as noise. */
const MAX_AVATARS = 3;

export function SubscribeToggle({
  assigneeId,
  members,
}: {
  /** Seeds the sample subscriber list — the assignee follows their own task. */
  assigneeId: string | null;
  members: Member[];
}) {
  const t = useT();
  const { data: session } = authClient.useSession();
  const myUserId = session?.user?.id;
  const [isSubscribed, setIsSubscribed] = useState(true);

  // Assignee first, then whoever else is around.
  const others = members
    .filter((m) => m.userId !== myUserId)
    .sort(
      (a, b) =>
        Number(b.userId === assigneeId) - Number(a.userId === assigneeId),
    )
    .slice(0, 2);
  const me = members.find((m) => m.userId === myUserId);
  const subscribers = [...(isSubscribed && me ? [me] : []), ...others];

  const shown = subscribers.slice(0, MAX_AVATARS);
  const overflow = subscribers.length - shown.length;

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setIsSubscribed((prev) => !prev)}
        className="h-7 px-2 text-sm font-normal text-muted-foreground"
      >
        {isSubscribed
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
