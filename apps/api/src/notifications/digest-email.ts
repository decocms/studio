/**
 * Pure: one recipient's unread notifications -> { subject, html }.
 *
 * The link is the existing short card link, whose route component redirects to
 * the board with the dialog open. `taskKey` returns null for a row written
 * before the key backfill; such a row renders its title without a link.
 */

import { taskKey } from "@decocms/shared/task-key";
import type { NotificationType } from "@decocms/shared/notification-types";
import { emailTemplate } from "@/auth/email-template";

export interface DigestRow {
  id: string;
  type: NotificationType;
  taskTitle: string;
  taskKeySeq: number | null;
  actorName: string | null;
  orgSlug: string;
}

const VERB: Record<NotificationType, string> = {
  created: "created",
  commented: "commented on",
  status_changed: "moved",
  assignee_changed: "reassigned",
  review_requested: "requested review on",
  review_approved: "approved",
  review_changes_requested: "requested changes on",
  merge_failed: "couldn't merge",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function line(row: DigestRow, baseUrl: string): string {
  const key =
    row.taskKeySeq === null ? null : taskKey(row.orgSlug, row.taskKeySeq);
  const actor = escapeHtml(row.actorName ?? "The agent");
  const title = escapeHtml(row.taskTitle);
  const label = key ? `${escapeHtml(key)} · ${title}` : title;
  const text = key
    ? `<a href="${baseUrl}/${encodeURIComponent(row.orgSlug)}/t/${encodeURIComponent(key)}" style="color:#141413;">${label}</a>`
    : label;
  return `<p style="margin:0 0 12px 0;font-size:14px;color:#141413;line-height:1.6;font-family:Inter,system-ui,sans-serif;">${actor} ${VERB[row.type]} ${text}</p>`;
}

export function buildDigestEmail(
  rows: DigestRow[],
  baseUrl: string,
): { subject: string; html: string } {
  const subject =
    rows.length === 1
      ? `1 update on your tasks`
      : `${rows.length} updates on your tasks`;
  return {
    subject,
    html: emailTemplate({
      preheader: subject,
      heading: subject,
      body: rows.map((row) => line(row, baseUrl)).join("\n"),
      footnote:
        "You received this because you follow these tasks. Open a task and use Unfollow to stop.",
    }),
  };
}
