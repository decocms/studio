/**
 * Thread normalization helpers for API responses.
 *
 * Provides consistent status derivation (e.g. "expired" for stale in_progress)
 * and hidden defaulting across all thread tools.
 */

import type { Thread, ThreadStatus } from "../../storage/types";
import type { ThreadEntity } from "@decocms/shared/thread/schema";

/**
 * Threads stuck in "in_progress" longer than this are surfaced as "expired".
 * This is a virtual status (never stored in the DB) so the thread can
 * resume if the stream reconnects.
 */
export const THREAD_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

/** Status values that may appear in API responses (includes virtual "expired"). */
export type ThreadStatusForResponse = ThreadStatus | "expired";

/**
 * Normalize a thread for API response:
 * - Defaults `hidden` to `false` when null
 * - Detects in_progress threads older than 30 minutes and marks them as "expired"
 *
 * @param thread - The thread from storage
 * @param now - Current timestamp in ms (for testing only; never pass user input)
 */
/**
 * Project a storage Thread onto the public ThreadEntity shape advertised by
 * COLLECTION_THREADS_* output schemas. Internal runtime fields
 * (context_start_message_id, run_owner_pod, run_started_at) are stripped so
 * MCP clients validating structuredContent with Ajv don't reject the response.
 */
export function normalizeThreadForResponse(
  thread: Thread,
  now: number = Date.now(),
): ThreadEntity {
  let status: ThreadStatusForResponse = thread.status;

  if (status === "in_progress") {
    // Liveness = the most recent of `updated_at` (bumped by terminal writers)
    // and `last_progress_at` (bumped per streamed chunk, throttled). A
    // still-streaming run keeps `last_progress_at` fresh even though
    // `updated_at` stays stale for the whole turn, so keying only off
    // `updated_at` would falsely flip an actively-streaming thread to
    // "expired" after 30 min. Use the same heartbeat the reaper trusts.
    const updatedAtMs = new Date(thread.updated_at).getTime();
    const progressAtMs = thread.last_progress_at
      ? new Date(thread.last_progress_at).getTime()
      : Number.NaN;
    const lastActiveMs = Math.max(
      Number.isFinite(updatedAtMs) ? updatedAtMs : Number.NEGATIVE_INFINITY,
      Number.isFinite(progressAtMs) ? progressAtMs : Number.NEGATIVE_INFINITY,
    );
    if (
      !Number.isFinite(lastActiveMs) ||
      now - lastActiveMs > THREAD_EXPIRY_MS
    ) {
      status = "expired";
    }
  }

  return {
    id: thread.id,
    organization_id: thread.organization_id,
    title: thread.title,
    description: thread.description,
    created_at: thread.created_at,
    updated_at: thread.updated_at,
    created_by: thread.created_by,
    updated_by: thread.updated_by,
    hidden: thread.hidden ?? false,
    status,
    virtual_mcp_id: thread.virtual_mcp_id || undefined,
    trigger_id: thread.trigger_id,
    branch: thread.branch,
    sandbox_provider_kind: thread.sandbox_provider_kind,
    harness_id: thread.harness_id,
    metadata:
      thread.metadata && Object.keys(thread.metadata).length > 0
        ? thread.metadata
        : undefined,
    run_config: thread.run_config,
  };
}
