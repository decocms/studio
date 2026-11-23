/**
 * Who a sandbox run is for: nobody, a member in a chat someone else opened, or
 * the member who opened the chat. What a run is told about a person, and
 * whether it gets that person's memory, is decided here and nowhere else.
 */

import type { ThreadMetadata } from "@decocms/shared/entities";
import { AUTOMATION_THREAD_KEY } from "@/storage/automations";
import {
  isBoardRunThread,
  resolveThreadToolNames,
  THREAD_TOOL_NAMES,
} from "@/tools/task-board/task-run-context";

/** The thread facts the decision reads. */
export interface RunThread {
  title?: string | null;
  metadata?: ThreadMetadata | null;
  trigger_id?: string | null;
  created_by?: string | null;
}

/**
 * - `unattended`: nobody is in the conversation.
 * - `attended`: a person is, but the run acts as a member who did not open the thread.
 * - `owner`: the run acts as the member who opened the thread.
 */
export type RunAudience = "unattended" | "attended" | "owner";

/** A thread nobody opened: the board's runs (reviewer and Jira included) and an automation's. */
function isUnattendedThread(thread: RunThread): boolean {
  if (thread.trigger_id) return true;
  if (typeof thread.metadata?.[AUTOMATION_THREAD_KEY] === "string") return true;
  if (isBoardRunThread(thread)) return true;
  return resolveThreadToolNames(thread) !== THREAD_TOOL_NAMES;
}

/**
 * Who a thread is for, from how it was born and who opened it. A person
 * commenting on a card or typing into a board run's thread does not change it.
 */
export function threadAudience(
  thread: RunThread | null | undefined,
  /** The member the run acts as. */
  userId: string,
): RunAudience {
  if (!thread || isUnattendedThread(thread)) return "unattended";
  return thread.created_by === userId ? "owner" : "attended";
}

/**
 * Who one run is for. A run the board or a trigger classed, or one whose
 * thread an integration stamped as its own, has nobody in it even when the
 * thread reads like a chat; otherwise the thread decides.
 */
export function runAudience(args: {
  /** `runMetadata.runClass`: set by the board and by triggered runs. */
  runClass: string | undefined;
  thread: RunThread | null | undefined;
  /** The member the run acts as. */
  userId: string;
}): RunAudience {
  if (args.runClass || args.thread?.metadata?.source) return "unattended";
  return threadAudience(args.thread, args.userId);
}
