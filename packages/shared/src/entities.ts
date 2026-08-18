import type { Metadata } from "./chat.ts";

export const THREAD_STATUSES = [
  "in_progress",
  "requires_action",
  "failed",
  "completed",
] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];
export type ThreadDisplayStatus = ThreadStatus | "expired";

/**
 * `threads.failure_kind`s where `failed` is not the run's outcome: the run had
 * already delivered its work when it died (`ended_after_delivery`), or a newer
 * attempt replaced it (`superseded`). Both are settled history, so they render
 * muted rather than as an error — 236 of the 307 failed task-board threads in
 * one month sat on cards that reached In Review or Done.
 */
export const RESOLVED_RUN_FAILURE_KINDS = [
  "ended_after_delivery",
  "superseded",
] as const;

export function isResolvedRunFailure(kind: string | null | undefined): boolean {
  return (
    !!kind && (RESOLVED_RUN_FAILURE_KINDS as readonly string[]).includes(kind)
  );
}

export interface ThreadExpandedTool {
  toolName: string;
  appId: string;
  args: Record<string, unknown>;
  expandedAt: string;
}

export interface ThreadMetadata {
  expanded_tools?: ThreadExpandedTool[];
  /**
   * The thread takes no further input. Set at creation for autonomous runs the
   * user cannot continue — a sandbox-hosted `claude-code` task run is one
   * dispatch with one prompt, so a follow-up message would queue against a run
   * nothing will ever deliver it to.
   */
  read_only?: boolean;
  [key: string]: unknown;
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
  /** `threads.failure_kind` — null unless `status` is `failed`. See
   *  `isResolvedRunFailure` for the kinds that are not an error. */
  failureKind: string | null;
  /** False when the thread was created and never used — see
   *  `TaskBoardItemThreadRef` in `apps/api/src/storage/types.ts`. */
  hasMessages: boolean;
  /** USD this run has cost so far, from the usage its harness recorded. `null`
   *  when nothing was recorded — not the same as free. */
  costUsd: number | null;
  createdAt: string;
}

/** A tag attached to a task, plus who attached it and when. */
export interface TaskBoardItemTagRef {
  id: string;
  name: string;
  color: string | null;
  createdBy: string;
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
  /** `owner/name` of the repo (site) this task pertains to. */
  repo: string | null;
  dueDate: string | null;
  /** Manual drag-to-reorder position within a lane, ascending. */
  sortOrder: number;
  threads: TaskBoardItemThreadRef[];
  tags: TaskBoardItemTagRef[];
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
