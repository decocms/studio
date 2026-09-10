import type { Task } from "@/components/chat/task/types";
import { threadHasMessages } from "./thread-has-messages";

/**
 * Drop the user's abandoned empty "New chat" rows from a rendered thread list.
 *
 * A fresh chat is persisted to the DB the moment "New chat" is opened — before
 * anything is typed — so without this filter every abandoned "New chat" piles
 * up in the list forever. `threadHasMessages` is the shared emptiness test
 * (`harness_id` pinned on the first message, or a non-default title).
 *
 * Two kinds of empty row are kept:
 *  - the ACTIVE thread (`activeTaskId`) — it may be the empty chat the user is
 *    about to type into, and it must not vanish from under them.
 *  - automation rows (`trigger_id`) — a scheduled run can legitimately sit
 *    un-started with the default title; it is activity, not user clutter.
 */
export function hideAbandonedNewChats(
  threads: Task[],
  activeTaskId: string | null | undefined,
): Task[] {
  return threads.filter(
    (thread) =>
      thread.id === activeTaskId ||
      Boolean(thread.trigger_id) ||
      threadHasMessages(thread),
  );
}
