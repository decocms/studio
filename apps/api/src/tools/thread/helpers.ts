/**
 * Thread normalization helpers for API responses.
 *
 * Provides consistent status derivation (e.g. "expired" for stale in_progress)
 * and hidden defaulting across all thread tools.
 */

import type { Thread, ThreadStatus } from "../../storage/types";
import type { VirtualMCPStoragePort } from "../../storage/ports";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types/virtual-mcp";
import type { ThreadEntity } from "@decocms/shared/thread/schema";

/** Shape of the `githubRepo` field on a virtual MCP's `metadata` column. */
export type GithubRepoMeta = {
  githubRepo?: {
    owner: string;
    name: string;
    connectionId?: string;
  } | null;
};

/**
 * Look up a virtual MCP by id and confirm it belongs to `organizationId`.
 * `findById`'s organizationId param only resolves well-known synthetic ids
 * (decopilot, brand-context-setup) — for a normal row it does NOT filter by
 * org, so existence alone doesn't prove the vMCP is ours. Throws (rather than
 * returning null) so a thread create/update can't silently no-op against a
 * missing vMCP.
 */
export async function requireOwnedVirtualMcp(
  virtualMcps: VirtualMCPStoragePort,
  virtualMcpId: string,
  organizationId: string,
): Promise<VirtualMCPEntity> {
  const vmcp = await virtualMcps.findById(virtualMcpId, organizationId);
  if (!vmcp || vmcp.organization_id !== organizationId) {
    throw new Error(`Virtual MCP not found: ${virtualMcpId}`);
  }
  return vmcp;
}

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
/**
 * True when an `in_progress` thread has shown no sign of life for longer than
 * `THREAD_EXPIRY_MS` — the single definition of "this run is not coming back".
 *
 * Liveness = the most recent of `updated_at` (bumped by terminal writers) and
 * `last_progress_at` (bumped per streamed chunk, throttled). A still-streaming
 * run keeps `last_progress_at` fresh even though `updated_at` stays stale for
 * the whole turn, so keying only off `updated_at` would falsely flip an
 * actively-streaming thread to "expired" after 30 min. Use the same heartbeat
 * the reaper trusts.
 *
 * Says nothing about `status`: callers check that themselves, because the two
 * uses differ. The response normalizer renders a virtual "expired" (never
 * stored, so the thread can resume if the stream reconnects); board stall
 * recovery persists a failure, and only for a run no pod can still own.
 */
export function isThreadRunStale(
  thread: Pick<Thread, "updated_at" | "last_progress_at">,
  now: number = Date.now(),
): boolean {
  const updatedAtMs = new Date(thread.updated_at).getTime();
  const progressAtMs = thread.last_progress_at
    ? new Date(thread.last_progress_at).getTime()
    : Number.NaN;
  const lastActiveMs = Math.max(
    Number.isFinite(updatedAtMs) ? updatedAtMs : Number.NEGATIVE_INFINITY,
    Number.isFinite(progressAtMs) ? progressAtMs : Number.NEGATIVE_INFINITY,
  );
  return (
    !Number.isFinite(lastActiveMs) || now - lastActiveMs > THREAD_EXPIRY_MS
  );
}

export function normalizeThreadForResponse(
  thread: Thread,
  now: number = Date.now(),
): ThreadEntity {
  let status: ThreadStatusForResponse = thread.status;

  if (status === "in_progress" && isThreadRunStale(thread, now)) {
    status = "expired";
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
