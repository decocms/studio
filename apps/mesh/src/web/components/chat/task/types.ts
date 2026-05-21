import type { ThreadDisplayStatus } from "@decocms/mesh-sdk";
import type { ThreadMetadata } from "@/storage/types";

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
  /** Per-thread metadata — layout tabs, expanded tools, etc. Loaded by COLLECTION_THREADS_GET. */
  metadata?: ThreadMetadata;
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
      | "metadata"
    >
  >;
