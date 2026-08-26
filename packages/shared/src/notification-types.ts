/**
 * The one list of notification types.
 *
 * Three consumers need it and none may import the others: the migration's
 * CHECK constraint (bound by a test), the API's zod enum, and the inbox UI's
 * `InboxTaskAction`.
 *
 * Unprefixed on purpose — every value except `commented`/`mentioned` is already a
 * `TaskBoardActivityAction`, so the fan-out passes `entry.action` straight
 * through with no prefix to add and none to strip again in the UI.
 */
export const NOTIFICATION_TYPES = [
  "created",
  "commented",
  "mentioned",
  "status_changed",
  "assignee_changed",
  "review_requested",
  "review_approved",
  "review_changes_requested",
  "merge_failed",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * Org-scoped SSE event pushed on `sseHub` after a notification row commits.
 * `subject` is the recipient's user id and `data` carries nothing else — the
 * hub fans out per org, so every member's stream sees it and only the addressed
 * client refetches. Keeping the payload empty is what stops one member's inbox
 * from streaming through another's connection.
 */
export const NOTIFICATION_CREATED_EVENT = "notification.created";
