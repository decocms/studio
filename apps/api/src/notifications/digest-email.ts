/**
 * Pure: one recipient's unread notifications -> { subject, html }.
 *
 * The link is the existing short card link, whose route component redirects to
 * the board with the dialog open. `taskKey` returns null for a row written
 * before the key backfill; such a row renders its title without a link.
 */

import { taskKey } from "@decocms/shared/task-key";
import type { NotificationType } from "@decocms/shared/notification-types";
import {
  type OrderIncidentNotice,
  orderMonitorChartPath,
} from "@decocms/shared/order-monitor";
import { emailTemplate } from "@/auth/email-template";

export interface DigestRow {
  id: string;
  type: NotificationType;
  taskTitle: string;
  taskKeySeq: number | null;
  actorName: string | null;
  orgSlug: string;
  incident?: OrderIncidentNotice;
}

const VERB: Record<NotificationType, string> = {
  created: "created",
  commented: "commented on",
  mentioned: "mentioned you on",
  status_changed: "moved",
  assignee_changed: "reassigned",
  review_requested: "requested review on",
  review_approved: "approved",
  review_changes_requested: "requested changes on",
  merge_failed: "couldn't merge",
  order_incident: "flagged an order incident on",
};

const RULE_LABEL: Record<OrderIncidentNotice["rule"], string> = {
  orders_drop: "Orders",
  denied_spike: "Payment denials",
  cancel_spike: "Cancellations",
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
  if (row.incident)
    return incidentLine(row.incident, text, row.orgSlug, baseUrl);
  return `<p style="margin:0 0 12px 0;font-size:14px;color:#141413;line-height:1.6;font-family:Inter,system-ui,sans-serif;">${actor} ${VERB[row.type]} ${text}</p>`;
}

/** Store, rule, observed vs expected, since when, and the chart at that instant. */
function incidentLine(
  incident: OrderIncidentNotice,
  task: string,
  orgSlug: string,
  baseUrl: string,
): string {
  const since = new Date(incident.since).toLocaleTimeString("en-GB", {
    timeZone: incident.timezone,
    hour: "2-digit",
    minute: "2-digit",
  });
  const state =
    incident.status === "ok"
      ? "recovered"
      : `${incident.status} since ${since}`;
  const chart = `${baseUrl}${orderMonitorChartPath(orgSlug, incident.connectionId, incident.at)}`;
  return `<p style="margin:0 0 12px 0;font-size:14px;color:#141413;line-height:1.6;font-family:Inter,system-ui,sans-serif;"><strong>${escapeHtml(incident.store)}</strong> · ${RULE_LABEL[incident.rule]} ${state}: ${Math.round(incident.observed)} in the last hour vs ${Math.round(incident.expected)} expected. <a href="${escapeHtml(chart)}" style="color:#141413;">Open the chart</a> · ${task}</p>`;
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
