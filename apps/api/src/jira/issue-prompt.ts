/**
 * A Jira issue, rendered for an agent to read.
 *
 * The run's opening message and `JIRA_ISSUE_GET` both show the issue this way:
 * summary, status, description, the comment thread, and the attachments by
 * id — the id being what `JIRA_ATTACHMENT_DOWNLOAD` takes. Rendered, not
 * stored: the issue's home is Jira, and the only copy Studio keeps is inside
 * the run's own transcript.
 */

import {
  collectMentionAccountIds,
  type JiraClient,
  jiraBodyToText,
  JiraUserDirectory,
} from "./client";

export interface IssueForPrompt {
  key: string;
  url: string;
  summary: string;
  status: string;
  description: string;
  comments: Array<{ author: string; created: string; body: string }>;
  attachments: Array<{ id: string; filename: string; size: number }>;
}

/** Caps so one sprawling issue cannot crowd out the instruction. */
const MAX_DESCRIPTION_CHARS = 12_000;
const MAX_COMMENTS_CHARS = 12_000;

export function issueUrl(siteUrl: string, key: string): string {
  return `${siteUrl.replace(/\/+$/, "")}/browse/${encodeURIComponent(key)}`;
}

/** Read everything the prompt shows, resolving mentions to names once. */
export async function loadIssueForPrompt(
  client: JiraClient,
  siteUrl: string,
  issueId: string,
): Promise<IssueForPrompt> {
  const [issue, comments] = await Promise.all([
    client.getIssue(issueId),
    client.listComments(issueId),
  ]);
  const users = new JiraUserDirectory(client);
  const names = await users.resolve([
    ...collectMentionAccountIds(issue.fields.description),
    ...comments.flatMap((c) => collectMentionAccountIds(c.body)),
  ]);
  return {
    key: issue.key,
    url: issueUrl(siteUrl, issue.key),
    summary: issue.fields.summary,
    status: issue.fields.status.name,
    description: jiraBodyToText(issue.fields.description, names).trim(),
    comments: comments.map((c) => ({
      author: c.author?.displayName ?? "Unknown",
      created: c.created,
      body: jiraBodyToText(c.body, names).trim(),
    })),
    attachments: (issue.fields.attachment ?? []).map((a) => ({
      id: a.id,
      filename: a.filename,
      size: a.size,
    })),
  };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n\n[… truncated]` : text;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function renderIssueForPrompt(issue: IssueForPrompt): string {
  const lines: string[] = [
    `# ${issue.key}: ${issue.summary}`,
    `Status: ${issue.status}`,
    `Link: ${issue.url}`,
    "",
    "## Description",
    issue.description
      ? clip(issue.description, MAX_DESCRIPTION_CHARS)
      : "_(empty)_",
  ];
  if (issue.attachments.length > 0) {
    lines.push("", "## Attachments");
    for (const a of issue.attachments) {
      lines.push(
        `- ${a.filename} (${humanSize(a.size)}) — attachment id \`${a.id}\``,
      );
    }
    lines.push(
      "",
      "Fetch one with `JIRA_ATTACHMENT_DOWNLOAD` and the attachment id; it returns a short-lived URL to `curl` into the sandbox.",
    );
  }
  if (issue.comments.length > 0) {
    lines.push("", "## Comments");
    let budget = MAX_COMMENTS_CHARS;
    for (const c of issue.comments) {
      const body = clip(c.body, Math.max(0, budget));
      lines.push(`**${c.author}** (${c.created}):`, body, "");
      budget -= body.length;
      if (budget <= 0) {
        lines.push("[… older comments omitted]");
        break;
      }
    }
  }
  return lines.join("\n").trim();
}
