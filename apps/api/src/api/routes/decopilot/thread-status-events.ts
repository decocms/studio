import {
  createDecopilotThreadStatusEvent,
  type ThreadStatus,
} from "@decocms/shared/sdk";
import type { SSEEvent } from "@/event-bus";

/** Minimal thread-row shape needed to build a `decopilot.thread.status` event. */
export interface TerminalThreadStatusRow {
  status: ThreadStatus;
  title?: string | null;
  virtual_mcp_id?: string | null;
  created_by?: string | null;
  trigger_id?: string | null;
  branch?: string | null;
  created_at?: string;
  updated_at?: string;
}

/**
 * Emit the org-wide `decopilot.thread.status` SSE event for a terminal run
 * transition performed by the durable projector.
 *
 * user-desktop runs finalize via the projector (`completeRunIfNotCompleted` /
 * `markRunFailed`), NOT via the in-memory run-reactor that hosted runs use — so
 * without this emit the sidebar status chip never receives a real-time
 * completed/failed push and stays "running" until the next refetch (a manual
 * refresh or the SSE reconnect recovery). This mirrors the emit the run-reactor
 * already does for hosted runs (`run-reactor.handleTerminalStatus`).
 *
 * `row` is the row returned by the conditional flip (`WHERE status =
 * 'in_progress'`): non-null only when THIS call actually transitioned the run.
 * A null row emits nothing, so a no-op flip — e.g. a hosted run already
 * finalized by the live path before the projector backstop ran — never
 * double-publishes. Returns whether an event was emitted.
 */
export function emitTerminalThreadStatus(
  sseHub: { emit(orgId: string, event: SSEEvent): void },
  orgId: string,
  runId: string,
  row: TerminalThreadStatusRow | null,
): boolean {
  if (!row) return false;
  sseHub.emit(
    orgId,
    createDecopilotThreadStatusEvent(runId, row.status, {
      title: row.title ?? undefined,
      virtualMcpId: row.virtual_mcp_id ?? undefined,
      createdBy: row.created_by ?? undefined,
      triggerId: row.trigger_id ?? null,
      branch: row.branch ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
  );
  return true;
}
