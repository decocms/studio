import type { ThreadDisplayStatus } from "@decocms/mesh-sdk";

// Constants
export const THREAD_CONSTANTS = {
  /** Page size for thread messages queries */
  THREAD_MESSAGES_PAGE_SIZE: 100,
  /** Page size for threads list queries */
  THREADS_PAGE_SIZE: 50,
  /** Stale time for React Query queries (30 seconds) */
  QUERY_STALE_TIME: 30_000,
} as const;

// Types
export interface Thread {
  id: string;
  title: string;
  created_at: string; // ISO string
  updated_at: string; // ISO string
  hidden?: boolean;
  /** Execution status from server — includes virtual "expired" for stale in_progress threads */
  status?: ThreadDisplayStatus;
}

export type { ChatMessage } from "../types.ts";

export type ThreadsInfiniteQueryData = {
  pages: Array<{
    items: Thread[];
    hasMore: boolean;
    totalCount?: number;
  }>;
  pageParams: number[];
};
