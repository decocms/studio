import type { ThreadDisplayStatus } from "@/sdk";
import type { ThreadMetadata } from "@decocms/shared/entities";

// Types
export interface Task {
  id: string;
  title: string;
  created_at: string; // ISO string
  updated_at: string; // ISO string
  hidden?: boolean;
  created_by?: string;
  /** Execution status from server — includes virtual "expired" for stale in_progress tasks */
  status?: ThreadDisplayStatus;
  /** Virtual MCP (agent) this task was initiated with */
  virtual_mcp_id?: string;
  /**
   * Automation trigger that created this thread, when applicable.
   * `null` (or absent) ⇒ human-initiated. Use `Boolean(task.trigger_id)`
   * to ask "is this an automation?".
   */
  trigger_id?: string | null;
  /** Git branch associated with this thread, when the vMCP is GitHub-linked. */
  branch?: string | null;
  /** Sandbox provider kind pinned on first message (e.g. "agent-sandbox", "user-desktop"). */
  sandbox_provider_kind?: string | null;
  /** Harness id pinned on first message (e.g. "claude-code", "codex", "decopilot"). */
  harness_id?: string | null;
  /** Per-thread metadata — layout tabs, expanded tools, etc. Loaded by COLLECTION_THREADS_GET. */
  metadata?: ThreadMetadata;
  /**
   * Client-only: this row was synthesized from a `/watch` patch, which carries
   * no `metadata`. Absent fields mean "not loaded", NOT "not set" — a reader
   * that treats a partial row as authoritative sees an unstamped thread and
   * resolves the project default instead of the session's own runtime.
   */
  partial?: true;
}

export type { ChatMessage } from "../types.ts";

/**
 * Partial Task patch — every store update goes through one of these. `id`
 * pins the row; the rest are optional overrides applied via spread.
 */
export type RowPatch = Pick<Task, "id"> &
  Partial<
    Pick<
      Task,
      | "status"
      | "created_at"
      | "updated_at"
      | "title"
      | "branch"
      | "created_by"
      | "trigger_id"
      | "virtual_mcp_id"
      | "harness_id"
      | "sandbox_provider_kind"
      | "metadata"
    >
  >;
