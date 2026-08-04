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
  routing_locked_at?: string | null;
  hosted_execution_disabled_at?: string | null;
  harness_id?: string | null;
  sandbox_provider_kind?: string | null;
}

/**
 * Emit the org-wide `decopilot.thread.status` SSE event for a terminal run
 * transition performed by the durable projector.
 *
 * Projector terminal transitions happen outside the in-memory run reactor, so
 * this emit keeps the sidebar status chip current without waiting for a
 * refetch. It mirrors `run-reactor.handleTerminalStatus` for the durable path.
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
      routingLockedAt: row.routing_locked_at,
      hostedExecutionDisabledAt: row.hosted_execution_disabled_at,
      harnessId: row.harness_id,
      sandboxProviderKind: row.sandbox_provider_kind,
    }),
  );
  return true;
}
