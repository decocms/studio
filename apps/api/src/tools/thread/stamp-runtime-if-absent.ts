import type { StudioContext } from "../../core/studio-context";
import type { ThreadRuntime } from "@decocms/shared/thread/session-runtime";

/**
 * Write a runtime onto a thread that has none — the drain that makes the
 * claim's no-stamp fallback temporary instead of permanent.
 *
 * Only-if-absent and idempotent, in ONE guarded statement: the `WHERE` clause
 * is what makes it unable to move a session, and what keeps it from clobbering
 * a concurrent metadata write the way a read-modify-write in app code would
 * (`update()` writes `metadata` as a whole blob).
 *
 * Fire-and-forget from a read path; never awaited, never fatal.
 */
export async function stampRuntimeIfAbsent(
  ctx: StudioContext,
  threadId: string,
  runtime: ThreadRuntime,
): Promise<void> {
  try {
    await ctx.storage.threads.stampRuntimeIfAbsent(threadId, runtime);
  } catch (err) {
    console.warn(
      `[stampRuntimeIfAbsent] ${threadId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
