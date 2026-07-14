import type { Task } from "@/web/components/chat/task/types";

/**
 * The agent's existing empty "New chat" thread, or undefined if it has none.
 *
 * `"New chat"` is the marker of a never-auto-titled thread — a thread gets
 * titled once it completes a *successful* turn. We do NOT gate on `status`
 * (a fresh empty thread can carry any/no status, and gating on `in_progress`
 * is what let duplicate empty chats pile up when the same agent was
 * re-selected). But title alone is too loose: a thread whose first message
 * FAILED keeps the "New chat" title forever, so we'd reuse a dead,
 * non-empty, runtime-locked thread — stranding the user on a broken
 * conversation. `harness_id` is pinned on the first message, so `!harness_id`
 * means the thread is genuinely empty. That excludes failed/in-flight threads
 * while still reusing real empty chats. Every entry point that navigates to an
 * agent (the breadcrumb picker, the org-home resolver, the repo switcher, …)
 * reuses this so re-selecting an agent focuses its empty chat instead of
 * minting another.
 */
export function findReusableNewChat(
  threads: Task[],
  agentId: string,
): Task | undefined {
  return threads.find(
    (t) =>
      !t.hidden &&
      t.virtual_mcp_id === agentId &&
      t.title === "New chat" &&
      !t.harness_id,
  );
}
