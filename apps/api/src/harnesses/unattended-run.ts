/**
 * Whether anybody is in a sandbox run's conversation. What a run is told about
 * a person, and whether it gets a person's memory, starts from this and
 * nowhere else.
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
 * A thread nobody opened: the board's runs (reviewer and Jira included) and an
 * automation's. It follows how the thread was born, so a person commenting on
 * a card or typing into a board run's thread does not change it.
 */
export function isUnattendedThread(thread: RunThread): boolean {
  if (thread.trigger_id) return true;
  if (typeof thread.metadata?.[AUTOMATION_THREAD_KEY] === "string") return true;
  if (isBoardRunThread(thread)) return true;
  return resolveThreadToolNames(thread) !== THREAD_TOOL_NAMES;
}

/**
 * A run nobody is in. A run the board or a trigger classed, or one whose
 * thread an integration stamped as its own, has nobody in it even when the
 * thread reads like a chat; otherwise the thread decides.
 */
export function isUnattendedRun(args: {
  /** `runMetadata.runClass`: set by the board and by triggered runs. */
  runClass: string | undefined;
  thread: RunThread | null | undefined;
}): boolean {
  const { thread } = args;
  if (args.runClass || !thread || thread.metadata?.source) return true;
  return isUnattendedThread(thread);
}
