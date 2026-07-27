import type { Metadata } from "./chat.ts";

export const THREAD_STATUSES = [
  "in_progress",
  "requires_action",
  "failed",
  "completed",
] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];
export type ThreadDisplayStatus = ThreadStatus | "expired";

export interface ThreadExpandedTool {
  toolName: string;
  appId: string;
  args: Record<string, unknown>;
  expandedAt: string;
}

export interface ThreadMetadata {
  expanded_tools?: ThreadExpandedTool[];
  /**
   * A shared room: every member of the organization may post in it, not just
   * the person who opened it. Absent/false means a personal chat — teammates
   * can read it (the sidebar's Team scope lists it) but not write to it.
   *
   * Enforced through `canWriteToThread`, which BOTH the API and the composer
   * call so the two can't drift.
   */
  shared?: boolean;
  [key: string]: unknown;
}

/**
 * May `userId` post in this thread?
 *
 * Org membership is verified upstream (the org-scoped route resolves the org
 * and rejects non-members, and threads are always fetched org-scoped), so the
 * only question left here is owner-vs-room:
 *  - a personal chat is writable by its owner alone;
 *  - a shared room is writable by any member who can reach it.
 *
 * Callers with no identity yet (`userId` null, session still loading) get
 * `false` — never assume a write is allowed while the actor is unknown.
 */
export function canWriteToThread(thread: {
  created_by?: string | null;
  metadata?: ThreadMetadata | null;
  userId: string | null | undefined;
}): boolean {
  if (!thread.userId) return false;
  if (thread.metadata?.shared === true) return true;
  // An unknown owner (legacy rows, optimistic local rows) stays writable by
  // whoever is holding it — matching the pre-rooms behavior.
  if (!thread.created_by) return true;
  return thread.created_by === thread.userId;
}

/**
 * Browser-visible thread representation. The API may retain additional
 * storage-only fields, but every response sent to clients satisfies this
 * contract.
 */
export interface StudioThread {
  id: string;
  organization_id: string;
  title: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by?: string;
  hidden: boolean | null;
  status: ThreadDisplayStatus;
  trigger_id: string | null;
  context_start_message_id: string | null;
  run_owner_pod: string | null;
  run_config: Record<string, unknown> | null;
  run_started_at: string | null;
  last_progress_at: string | null;
  virtual_mcp_id: string;
  branch: string | null;
  sandbox_provider_kind: string | null;
  harness_id: string | null;
  metadata: ThreadMetadata;
  message_storage_version: number;
  link_transport: string | null;
}

export interface StudioThreadMessage {
  id: string;
  thread_id: string;
  role: "user" | "assistant" | "system";
  parts: unknown[];
  metadata?: Metadata;
  created_at: string;
  updated_at: string;
}

export type TaskBoardItemStatus =
  | "triage"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done";

export type TaskBoardItemPriority =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "urgent";

export interface TaskBoardItemThreadRef {
  threadId: string;
  virtualMcpId: string | null;
  status: ThreadStatus | null;
  title: string | null;
  lastMessage: string | null;
  hasPreview: boolean;
  createdAt: string;
}

export interface TaskBoardItem {
  id: string;
  organizationId: string;
  title: string;
  description: string | null;
  status: TaskBoardItemStatus;
  priority: TaskBoardItemPriority;
  assigneeId: string | null;
  assignedBy: string | null;
  dueDate: string | null;
  threads: TaskBoardItemThreadRef[];
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export interface BrandContext {
  id: string;
  organizationId: string;
  name: string;
  domain: string;
  overview: string;
  logo: string | null;
  favicon: string | null;
  ogImage: string | null;
  fonts: {
    heading?: string;
    body?: string;
    code?: string;
  } | null;
  colors: {
    primary?: string;
    secondary?: string;
    accent?: string;
    background?: string;
    foreground?: string;
  } | null;
  images: Record<string, unknown>[] | null;
  metadata: Record<string, unknown> | null;
  archivedAt: Date | string | null;
  isDefault: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
}

/** Sanitized organization SSO configuration returned to browser clients. */
export interface OrgSsoConfigPublic {
  id: string;
  organizationId: string;
  issuer: string;
  clientId: string;
  discoveryEndpoint: string | null;
  scopes: string[];
  domain: string;
  enforced: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
}
