import type { ThreadDisplayStatus } from "@decocms/mesh-sdk";

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
  /** Connection IDs that have been used in this task, ordered by first appearance */
  agent_ids?: string[];
}

export type { ChatMessage } from "../types.ts";

export type TasksInfiniteQueryData = {
  pages: Array<{
    items: Task[];
    hasMore: boolean;
    totalCount?: number;
  }>;
  pageParams: number[];
};
