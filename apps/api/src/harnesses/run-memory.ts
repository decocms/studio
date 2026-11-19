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
import type { HarnessStreamInputWire } from "@decocms/sandbox/dispatch/schemas";
import type { ThreadMetadata } from "@decocms/shared/entities";
import { AUTOMATION_THREAD_KEY } from "@/storage/automations";
import {
  isBoardRunThread,
  resolveThreadToolNames,
  THREAD_TOOL_NAMES,
} from "@/tools/task-board/task-run-context";

type RunMemory = NonNullable<HarnessStreamInputWire["memory"]>;

const OFF: RunMemory = { enabled: false };

interface MemoryThread {
  title?: string | null;
  metadata?: ThreadMetadata | null;
  trigger_id?: string | null;
  created_by?: string | null;
}

/** A thread nobody opened: the board's runs (reviewer and Jira included) and an automation's. */
function isUnattendedThread(thread: MemoryThread): boolean {
  if (thread.trigger_id) return true;
  if (typeof thread.metadata?.[AUTOMATION_THREAD_KEY] === "string") return true;
  if (isBoardRunThread(thread)) return true;
  return resolveThreadToolNames(thread) !== THREAD_TOOL_NAMES;
}

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
  thread: MemoryThread | null | undefined;
}): RunMemory | undefined {
  if (!args.enabled) return undefined;
  const { thread, userId } = args;
  if (!thread || isUnattendedThread(thread)) return OFF;
  // Only the member who opened the chat: nobody loads a teammate's memory.
  if (thread.created_by !== userId) return OFF;
  if (!args.orgFsMounted || !isFolderName(userId)) return OFF;
  return { enabled: true, directory: userMemoryDir(userId) };
}
