/**
 * Whether a sandbox run gets Claude Code's memory, and whose.
 *
 * A chat a person opened reads and writes that person's memory: one folder per
 * member per organization, on the org filesystem, shared by all their chats.
 * A thread the task board or an automation created gets none. The rule follows
 * how the thread was born, so a person commenting on a card or typing into a
 * board run's thread does not turn memory on there.
 */

import { userMemoryDir } from "@decocms/shared/memory";
import { isUnattendedThread, type RunThread } from "@/harnesses/unattended-run";

/** The dispatch input's `memory`. Declared here so the decision stays sandbox-free; the dispatch glue types it against the wire schema. */
type RunMemory = { enabled: false } | { enabled: true; directory: string };

const OFF: RunMemory = { enabled: false };

/** One path segment, so the folder cannot name anything but that member's own. */
function isFolderName(userId: string): boolean {
  return userId !== "." && userId !== ".." && /^[^/\\\0]+$/.test(userId);
}

/**
 * The `memory` a dispatch carries. `undefined` leaves the harness default,
 * which is what an org gets back by turning the flag off.
 */
export function resolveRunMemory(args: {
  /** The org's `sandbox_chat_user_memory` flag. */
  enabled: boolean;
  /** False when this deployment mounts no org filesystem in sandboxes. */
  orgFsMounted: boolean;
  /** The member the run acts as. */
  userId: string;
  thread: RunThread | null | undefined;
}): RunMemory | undefined {
  if (!args.enabled) return undefined;
  const { thread, userId } = args;
  if (!thread || isUnattendedThread(thread)) return OFF;
  // Only the member who opened the chat: nobody loads a teammate's memory.
  if (thread.created_by !== userId) return OFF;
  if (!args.orgFsMounted || !isFolderName(userId)) return OFF;
  return { enabled: true, directory: userMemoryDir(userId) };
}
