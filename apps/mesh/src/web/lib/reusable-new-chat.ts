import type { Task } from "@/web/components/chat/task/types";

/**
 * The agent's existing empty "New chat" thread, or undefined if it has none.
 *
 * `"New chat"` is the sole marker of a never-auto-titled (i.e. unused) thread —
 * a thread gets titled once it completes a turn. We intentionally do NOT gate
 * on `status`: a fresh empty thread can carry any/no status, and gating on
 * `in_progress` is exactly what let duplicate empty chats pile up when the same
 * agent was re-selected. Every entry point that navigates to an agent (the
 * breadcrumb picker, the org-home resolver, the repo switcher, …) reuses this
 * so re-selecting an agent focuses its empty chat instead of minting another.
 */
export function findReusableNewChat(
  threads: Task[],
  agentId: string,
): Task | undefined {
  return threads.find(
    (t) => !t.hidden && t.virtual_mcp_id === agentId && t.title === "New chat",
  );
}
