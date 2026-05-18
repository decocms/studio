import type { ThreadDisplayStatus } from "@decocms/mesh-sdk";
import type { ThreadMetadata } from "@/storage/types";

// Constants
export const TASK_CONSTANTS = {
  /** Page size for task messages queries */
  TASK_MESSAGES_PAGE_SIZE: 100,
  /** Page size for tasks list queries */
  TASKS_PAGE_SIZE: 50,
  /** Stale time for React Query queries (30 seconds) */
  QUERY_STALE_TIME: 30_000,
} as const;

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

export type TasksQueryData = {
  items: Task[];
  hasMore: boolean;
  totalCount?: number;
};
