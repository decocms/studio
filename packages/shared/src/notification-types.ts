/**
 * The one list of notification types.
 *
 * Three consumers need it and none may import the others: the migration's
 * CHECK constraint (bound by a test), the API's zod enum, and the inbox UI's
 * `InboxTaskAction`.
 *
 * Unprefixed on purpose — every value except `commented` is already a
 * `TaskBoardActivityAction`, so the fan-out passes `entry.action` straight
 * through with no prefix to add and none to strip again in the UI.
 */
export const NOTIFICATION_TYPES = [
  "created",
  "commented",
  "status_changed",
  "assignee_changed",
  "review_requested",
  "review_approved",
  "review_changes_requested",
  "merge_failed",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
