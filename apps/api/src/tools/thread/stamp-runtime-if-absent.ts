import type { StudioContext } from "../../core/studio-context";
import { parseThreadRuntime } from "@decocms/shared/thread/session-runtime";
import type { ThreadRuntime } from "@decocms/shared/thread/session-runtime";

/**
 * Write a runtime onto a thread that has none — the drain that makes the
 * claim's no-stamp fallback temporary instead of permanent.
 *
 * Only-if-absent and idempotent: it re-reads before writing, and never touches
 * a thread that already carries a stamp (so it can never move a session). A
 * lost read-modify-write race just means the fallback answers once more on the
 * next request, which is the same answer.
 *
 * Fire-and-forget from a read path; never awaited, never fatal.
 */
export async function stampRuntimeIfAbsent(
  ctx: StudioContext,
  threadId: string,
  runtime: ThreadRuntime,
): Promise<void> {
  try {
    const thread = await ctx.storage.threads.get(threadId);
    if (!thread) return;
    const metadata = (thread.metadata ?? {}) as Record<string, unknown>;
    if (parseThreadRuntime(metadata.runtime)) return;
    await ctx.storage.threads.update(threadId, {
      metadata: { ...metadata, runtime },
    });
  } catch (err) {
    console.warn(
      `[stampRuntimeIfAbsent] ${threadId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
