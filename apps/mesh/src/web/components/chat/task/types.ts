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
  /** ID of the automation that triggered this task, when triggered by an automation. */
  automation_id?: string | null;
  /** Git branch associated with this thread, when the vMCP is GitHub-linked. */
  branch?: string | null;
  /** Per-thread metadata — layout tabs, expanded tools, etc. Loaded by COLLECTION_THREADS_GET. */
  metadata?: ThreadMetadata;
}

export type { ChatMessage } from "../types.ts";

export type TasksPage = {
  items: Task[];
  hasMore: boolean;
  totalCount?: number;
};

/**
 * Cache shape for thread-list queries. Stored as paged data by
 * `useSuspenseInfiniteQuery` — every page-aware reader/writer (event
 * bridge, infinite scroll, helpers like `readCachedLastThread`) must
 * walk `pages` rather than reading a flat `items` array.
 */
export type TasksQueryData = {
  pages: TasksPage[];
  pageParams: number[];
};

/**
 * The two shapes a thread-list cache key can carry. `org` is the unscoped
 * view; `agent` narrows by `virtualMcpId`. Used both by `useThreads` (as
 * the query argument) and by the event bridge (as the parsed shape of a
 * `KEYS.threads(…)` cache key).
 */
export type ThreadScope = "org" | { kind: "agent"; virtualMcpId: string };

/**
 * Partial Task patch — every cache write goes through one of these. `id`
 * pins the row; the rest are optional overrides applied via spread.
 */
export type RowPatch = Pick<Task, "id"> &
  Partial<
    Pick<
      Task,
      | "status"
      | "updated_at"
      | "title"
      | "branch"
      | "created_by"
      | "trigger_id"
      | "virtual_mcp_id"
    >
  >;
