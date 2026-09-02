import type { Task } from "@/components/chat/task/types";
import { parseThreadRuntime } from "@decocms/shared/thread/session-runtime";
import type { ThreadRuntime } from "@decocms/shared/thread/session-runtime";

/**
 * Whether a thread is reusable for a session of `expected` runtime.
 *
 * A thread's runtime is immutable, so an empty chat stamped with the OTHER
 * runtime is not reusable — focusing it would silently drop the user into a
 * coding session (or a CMS one) they didn't ask for.
 *
 * An unstamped row always matches: it predates the stamp and resolves to the
 * project default by definition. `undefined` — the caller couldn't resolve the
 * project — keeps the pre-existing unfiltered behavior rather than guessing.
 *
 * A `partial` (`/watch` synthetic) thread carries no metadata, so its absent
 * stamp is "not loaded", not "unstamped" — never reuse it, to avoid crossing
 * runtimes on a race with the feed.
 */
export function threadRuntimeMatches(
  thread: Task,
  expected: ThreadRuntime | undefined,
) {
  if (!expected) return true;
  if (thread.partial) return false;
  const stamp = parseThreadRuntime(thread.metadata?.runtime);
  return stamp === null || stamp === expected;
}
