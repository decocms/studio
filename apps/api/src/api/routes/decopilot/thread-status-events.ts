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
  harness_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

/**
 * Emit the org-wide `decopilot.thread.status` SSE event for a terminal run
 * transition performed by the durable projector.
 *
 * Projector-owned terminal transitions do not pass through the in-memory run
 * reactor, so without this emit the sidebar status chip stays "running" until
 * the next refetch. This mirrors the reactor's terminal-status event.
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
      harnessId: row.harness_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
  );
  return true;
}
