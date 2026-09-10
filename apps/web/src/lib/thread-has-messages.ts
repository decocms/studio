import type { Task } from "@/components/chat/task/types";

/**
 * Whether a thread row represents a conversation that has already had at least
 * one message — i.e. it is NOT an empty "New chat". This is the inverse of the
 * emptiness test in `findReusableNewChat`.
 *
 * `harness_id` is pinned on the first message (even one that failed or is still
 * in flight), so its presence is the primary signal. `title !== "New chat"`
 * covers legacy threads that completed a turn before `harness_id` was recorded —
 * a thread stays titled "New chat" until it finishes a successful turn.
 *
 * Used to force the chat panel open when returning to an agent whose layout opts
 * out of the chat panel (`chatDefaultOpen: false`): an empty composer stays
 * closed, but a real conversation reopens.
 */
export function threadHasMessages(thread: Task): boolean {
  return (
    Boolean(thread.harness_id) ||
    (!!thread.title && thread.title !== "New chat")
  );
}
