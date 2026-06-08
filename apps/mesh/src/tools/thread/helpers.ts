/**
 * Thread normalization helpers for API responses.
 *
 * Provides consistent status derivation (e.g. "expired" for stale in_progress)
 * and hidden defaulting across all thread tools.
 */

import type { Thread, ThreadStatus } from "../../storage/types";
import type { ThreadEntity } from "./schema";

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
    const updatedAtMs = new Date(thread.updated_at).getTime();
    if (!Number.isFinite(updatedAtMs) || now - updatedAtMs > THREAD_EXPIRY_MS) {
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
