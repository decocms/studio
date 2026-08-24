/**
 * Turning a batch of task activity into one email.
 *
 * Pure: no I/O, no clock, no DB. Everything here is a function of its
 * arguments, which is what makes the digest's wording and grouping testable
 * without a Postgres or an SMTP server.
 *
 * The prose deliberately stays terser than the task dialog's timeline. The
 * dialog can render a status chip with an icon inside a sentence; an email has
 * to survive Outlook, and the reader's decision is only ever "open the task or
 * not". Server-originated strings stay English, per the i18n scope in
 * CLAUDE.md.
 */

import { taskKey } from "@decocms/shared/task-key";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import {
  emailButton,
  emailParagraph,
  emailTemplate,
} from "../auth/email-template";
import type { TaskBoardActivityAction } from "../storage/types";

/** One activity row, flattened with the display name of whoever caused it. */
export interface DigestEvent {
  taskBoardItemId: string;
  taskTitle: string;
  taskKeySeq: number;
  action: TaskBoardActivityAction;
  /** Null for the agent's own work, or a member we can no longer resolve. */
  actorName: string | null;
  data: Record<string, unknown>;
  occurredAt: string;
}

/** Every update to one task, in the order they happened. */
export interface DigestTaskGroup {
  taskBoardItemId: string;
  taskTitle: string;
  taskKeySeq: number;
  events: DigestEvent[];
}

/**
 * `emailTemplate` interpolates its arguments as raw HTML, and task titles,
 * member names and review notes are all user-authored. Escape at every
 * boundary where they enter the markup.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Group by task, tasks ordered by their most recent update first. */
export function groupByTask(events: DigestEvent[]): DigestTaskGroup[] {
  const groups = new Map<string, DigestTaskGroup>();
  for (const event of events) {
    const existing = groups.get(event.taskBoardItemId);
    if (existing) {
      existing.events.push(event);
      continue;
    }
    groups.set(event.taskBoardItemId, {
      taskBoardItemId: event.taskBoardItemId,
      taskTitle: event.taskTitle,
      taskKeySeq: event.taskKeySeq,
      events: [event],
    });
  }
  const newest = (g: DigestTaskGroup) =>
    Math.max(...g.events.map((e) => new Date(e.occurredAt).getTime()));
  return [...groups.values()].sort((a, b) => newest(b) - newest(a));
}

const STATUS_LABELS: Record<string, string> = {
  triage: "Triage",
  todo: "To do",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  archived: "Archived",
};

const PRIORITY_LABELS: Record<string, string> = {
  none: "No priority",
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

const REVIEWER_LABELS: Record<string, string> = {
  code_review: "Code Reviewer",
  qa: "QA Agent",
};

const label = (map: Record<string, string>, value: unknown): string =>
  typeof value === "string" ? (map[value] ?? value) : "";

const reviewerLabel = (value: unknown): string =>
  label(REVIEWER_LABELS, value) || "A reviewer";

/** An assignee id as a person: the agent has a name, a member is looked up by
 *  the caller, and an unresolvable id reads as "someone". */
function assigneeLabel(
  value: unknown,
  nameOf: (userId: string) => string | null,
): string {
  if (value === SUPER_AGENT_ASSIGNEE_ID) return "the Super Agent";
  if (typeof value !== "string") return "someone";
  return nameOf(value) ?? "someone";
}

/**
 * One line of the digest: what changed, in a sentence. Plain text — the caller
 * escapes it, so a task title or a reviewer's notes can't inject markup.
 *
 * The switch is exhaustive on purpose: a new activity action fails to compile
 * here before it can ship as a blank line in someone's email.
 */
export function describeEvent(
  event: DigestEvent,
  nameOf: (userId: string) => string | null = () => null,
): string {
  const d = event.data;
  switch (event.action) {
    case "created":
      return "created this task";
    case "status_changed": {
      if (typeof d.retry === "number") {
        return `run failed, retrying (attempt ${d.retry} of ${d.of ?? d.retry})`;
      }
      const to = label(STATUS_LABELS, d.to);
      const from = label(STATUS_LABELS, d.from);
      return from ? `moved it from ${from} to ${to}` : `moved it to ${to}`;
    }
    case "assignee_changed":
      if (d.to == null) return "unassigned it";
      return d.to === SUPER_AGENT_ASSIGNEE_ID
        ? "delegated it to the Super Agent"
        : `assigned it to ${assigneeLabel(d.to, nameOf)}`;
    case "priority_changed":
      if (d.to === "none") return "cleared the priority";
      return `set the priority to ${label(PRIORITY_LABELS, d.to)}`;
    case "due_date_changed":
      if (d.to == null) return "cleared the due date";
      return `set the due date to ${String(d.to).slice(0, 10)}`;
    case "title_changed":
      return `renamed it to "${String(d.to ?? "")}"`;
    case "description_changed":
      return "updated the description";
    case "tags_changed": {
      if (!Array.isArray(d.to) || d.to.length === 0) return "cleared the tags";
      const names = d.to
        .map((tag) => (tag as { name?: string }).name)
        .filter((name): name is string => !!name);
      return `tagged it ${names.join(", ")}`;
    }
    case "review_requested":
      return `sent it to the ${reviewerLabel(d.reviewer)}`;
    case "review_approved":
      return `${reviewerLabel(d.reviewer)} approved it`;
    case "review_changes_requested":
      return `${reviewerLabel(d.reviewer)} requested changes`;
    case "merge_conflict_resolution":
      return "is resolving a merge conflict with the base branch";
    case "merge_failed":
      return "couldn't be merged";
    case "commented":
      return "commented";
    default: {
      const _exhaustive: never = event.action;
      return String(_exhaustive);
    }
  }
}

/** "Ana moved it to In Review" — the actor, when there is one to name. */
function eventLine(
  event: DigestEvent,
  nameOf: (userId: string) => string | null,
): string {
  const what = describeEvent(event, nameOf);
  return event.actorName ? `${event.actorName} ${what}` : what;
}

/** What the reader sees before opening: how much, and on what. */
export function digestSubject(
  groups: DigestTaskGroup[],
  orgSlug: string,
): string {
  const count = groups.reduce((n, g) => n + g.events.length, 0);
  const updates = count === 1 ? "1 update" : `${count} updates`;
  if (groups.length === 1) {
    const group = groups[0]!;
    const key = taskKey(orgSlug, group.taskKeySeq);
    return `${key ? `${key}: ` : ""}${updates}`;
  }
  return `${updates} on ${groups.length} tasks`;
}

/** The digest as a complete HTML email, in the shared branded shell. */
export function renderDigest({
  groups,
  orgName,
  orgSlug,
  baseUrl,
  nameOf = () => null,
}: {
  groups: DigestTaskGroup[];
  orgName: string;
  orgSlug: string;
  baseUrl: string;
  nameOf?: (userId: string) => string | null;
}): string {
  const count = groups.reduce((n, g) => n + g.events.length, 0);
  const org = escapeHtml(orgName);
  const sections = groups
    .map((group) => {
      const key = taskKey(orgSlug, group.taskKeySeq);
      const heading = escapeHtml(
        key ? `${key} · ${group.taskTitle}` : group.taskTitle,
      );
      const href = key
        ? `${baseUrl}/${encodeURIComponent(orgSlug)}/t/${encodeURIComponent(key)}`
        : `${baseUrl}/${encodeURIComponent(orgSlug)}?main=board&task=${encodeURIComponent(group.taskBoardItemId)}`;
      const lines = group.events
        .map(
          (event) =>
            `<li style="margin:0 0 6px 0;">${escapeHtml(eventLine(event, nameOf))}</li>`,
        )
        .join("");
      return `${emailParagraph(
        `<a href="${href}" style="color:#141413;text-decoration:none;"><strong>${heading}</strong></a>`,
      )}<ul style="margin:0 0 24px 0;padding-left:20px;font-size:14px;line-height:1.65;color:#7A7570;font-family:Inter,system-ui,sans-serif;">${lines}</ul>`;
    })
    .join("");

  return emailTemplate({
    preheader: `${count === 1 ? "1 update" : `${count} updates`} on tasks you follow in ${orgName}`,
    heading: "Updates on your tasks",
    subheading: `<strong>${count}</strong> ${count === 1 ? "update" : "updates"} in <strong>${org}</strong>.`,
    body: `${sections}${emailButton("Open your tasks", `${baseUrl}/${encodeURIComponent(orgSlug)}?main=board`)}`,
    footnote:
      "You get this because you follow these tasks. Open a task and choose Unsubscribe to stop.",
  });
}
