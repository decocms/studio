/**
 * Decopilot SSE Event Types
 *
 * Canonical type definitions for thread statuses and decopilot SSE events.
 * Shared between server (emitter) and client (consumer) for full type safety.
 */

// ============================================================================
// Thread Status
// ============================================================================

/** Persisted thread statuses (written to DB). */
export const THREAD_STATUSES = [
  "in_progress",
  "requires_action",
  "failed",
  "completed",
] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];

/**
 * Display statuses include "expired" — a virtual status computed at read time
 * for threads stuck in "in_progress" beyond a timeout threshold.
 * Never persisted to DB, but appears in API responses and UI.
 */
export const THREAD_DISPLAY_STATUSES = [...THREAD_STATUSES, "expired"] as const;
export type ThreadDisplayStatus = (typeof THREAD_DISPLAY_STATUSES)[number];

// ============================================================================
// SSE Event Type Constants
// ============================================================================

export const DECOPILOT_EVENTS = {
  STEP: "decopilot.step",
  FINISH: "decopilot.finish",
  THREAD_STATUS: "decopilot.thread.status",
} as const;

export type DecopilotEventType =
  (typeof DECOPILOT_EVENTS)[keyof typeof DECOPILOT_EVENTS];

export const ALL_DECOPILOT_EVENT_TYPES: DecopilotEventType[] =
  Object.values(DECOPILOT_EVENTS);

// ============================================================================
// Event Payloads (discriminated union on `type`)
// ============================================================================

interface BaseDecopilotEvent {
  id: string;
  source: "decopilot";
  /** Thread ID this event relates to */
  subject: string;
  time: string;
}

export interface DecopilotStepEvent extends BaseDecopilotEvent {
  type: typeof DECOPILOT_EVENTS.STEP;
  data: { stepCount: number };
}

export interface DecopilotFinishEvent extends BaseDecopilotEvent {
  type: typeof DECOPILOT_EVENTS.FINISH;
  data: { status: ThreadStatus };
}

export interface DecopilotThreadStatusEvent extends BaseDecopilotEvent {
  type: typeof DECOPILOT_EVENTS.THREAD_STATUS;
  data: {
    status: ThreadStatus;
    virtual_mcp_id?: string;
    /** User who created the thread; needed to populate filter-complete cache rows on the client. */
    created_by?: string;
    /** Automation trigger id; null for human-initiated, omitted when unknown. */
    trigger_id?: string | null;
    /** Thread title at emit time. Absent if caller didn't load the row. */
    title?: string;
    /** Branch this thread is pinned to (null when unpinned). Absent if caller didn't load the row. */
    branch?: string | null;
    /** Thread creation timestamp. Absent if caller didn't load the row. */
    created_at?: string;
    /** Last update timestamp; useful for the client to sort/dedupe. Absent if caller didn't load the row. */
    updated_at?: string;
  };
}

export type DecopilotSSEEvent =
  | DecopilotStepEvent
  | DecopilotFinishEvent
  | DecopilotThreadStatusEvent;

/** Map from event type string → typed payload (useful for generic handlers) */
export interface DecopilotEventMap {
  [DECOPILOT_EVENTS.STEP]: DecopilotStepEvent;
  [DECOPILOT_EVENTS.FINISH]: DecopilotFinishEvent;
  [DECOPILOT_EVENTS.THREAD_STATUS]: DecopilotThreadStatusEvent;
}

// ============================================================================
// Server-side Factories (create typed events for SSEHub.emit)
// ============================================================================

export function createDecopilotStepEvent(
  taskId: string,
  stepCount: number,
): DecopilotStepEvent {
  return {
    id: crypto.randomUUID(),
    type: DECOPILOT_EVENTS.STEP,
    source: "decopilot",
    subject: taskId,
    data: { stepCount },
    time: new Date().toISOString(),
  };
}

export function createDecopilotFinishEvent(
  taskId: string,
  status: ThreadStatus,
): DecopilotFinishEvent {
  return {
    id: crypto.randomUUID(),
    type: DECOPILOT_EVENTS.FINISH,
    source: "decopilot",
    subject: taskId,
    data: { status },
    time: new Date().toISOString(),
  };
}

export function createDecopilotThreadStatusEvent(
  taskId: string,
  status: ThreadStatus,
  opts?: {
    virtualMcpId?: string;
    createdBy?: string;
    triggerId?: string | null;
    title?: string;
    branch?: string | null;
    createdAt?: string;
    updatedAt?: string;
  },
): DecopilotThreadStatusEvent {
  return {
    id: crypto.randomUUID(),
    type: DECOPILOT_EVENTS.THREAD_STATUS,
    source: "decopilot",
    subject: taskId,
    data: {
      status,
      ...(opts?.virtualMcpId !== undefined && {
        virtual_mcp_id: opts.virtualMcpId,
      }),
      ...(opts?.createdBy !== undefined && { created_by: opts.createdBy }),
      ...(opts?.triggerId !== undefined && { trigger_id: opts.triggerId }),
      ...(opts?.title !== undefined && { title: opts.title }),
      ...(opts?.branch !== undefined && { branch: opts.branch }),
      ...(opts?.createdAt !== undefined && { created_at: opts.createdAt }),
      ...(opts?.updatedAt !== undefined && { updated_at: opts.updatedAt }),
    },
    time: new Date().toISOString(),
  };
}
