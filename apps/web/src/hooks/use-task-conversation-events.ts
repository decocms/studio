import { TASK_BOARD_CONVERSATION_UPDATED_EVENT } from "@decocms/shared/task-board";
import {
  NOTIFICATION_CREATED_EVENT,
  NOTIFICATION_READ_EVENT,
} from "@decocms/shared/notification-types";
import { useSyncExternalStore } from "react";
import { useProjectContext } from "@/sdk";
import { authClient } from "@/lib/auth-client";
import {
  taskConversationWatchView,
  taskForumWatchView,
} from "./watch-sse-pool";

const snapshot = () => 0;

/** All viewers receive comment changes; personal read/mention events carry
 * only an invalidation and are consumed by their addressed viewer. */
export function useTaskConversationEvents(
  onChange: (
    itemId: string | undefined,
    reason: "activity" | "read" | "resync",
  ) => void,
  forum = false,
) {
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const subscribe = (onStoreChange: () => void) => {
    const view = forum ? taskForumWatchView : taskConversationWatchView;
    return view.subscribe(
      org.slug,
      (event) => {
        try {
          const payload: { subject?: string; data?: { id?: unknown } } =
            JSON.parse(event.data);
          const personal =
            event.type === TASK_BOARD_CONVERSATION_UPDATED_EVENT ||
            event.type === NOTIFICATION_CREATED_EVENT ||
            event.type === NOTIFICATION_READ_EVENT;
          if (
            personal &&
            payload.subject &&
            payload.subject !== session?.user.id
          )
            return;
          onChange(
            typeof payload.data?.id === "string" ? payload.data.id : undefined,
            event.type === NOTIFICATION_READ_EVENT ||
              (event.type === TASK_BOARD_CONVERSATION_UPDATED_EVENT &&
                payload.subject)
              ? "read"
              : "activity",
          );
          onStoreChange();
        } catch {
          /* A malformed push is repaired by the fallback read. */
        }
      },
      () => onChange(undefined, "resync"),
    );
  };
  useSyncExternalStore(subscribe, snapshot, snapshot);
}
