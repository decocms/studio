/**
 * "An issue entered a Jira status that has a rule — run the agent on it."
 *
 * The one act behind both the webhook and the safety-net poll. Studio keeps no
 * copy of the issue: the run is anchored on a hidden board item (so quota,
 * pull requests and review keep working), the issue's content goes straight
 * into the run's opening message, and the agent updates the issue itself with
 * the Jira tools its run is served.
 *
 * Idempotency is per TRANSITION, not per issue: `jira_trigger_claims` holds
 * one row per changelog entry, so a redelivered webhook or the poll finding the
 * same entry dispatches nothing, while the issue entering the column again
 * later is a new run. The claim is taken right before dispatch, after the
 * anchor item exists, so a lost claim never leaves an item with no run.
 */

import { LANES, SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import type { StudioContext } from "@/core/studio-context";
import type { OrgJiraIntegration, TaskBoardItem } from "@/storage/types";
import { enqueueSuperAgentForTask } from "@/tools/task-board/enqueue-super-agent";
import { JiraClient, type JiraChangelogHistory } from "./client";
import {
  type IssueForPrompt,
  issueUrl,
  loadIssueForPrompt,
  renderIssueForPrompt,
} from "./issue-prompt";

export interface IssueTransition {
  issueId: string;
  issueKey: string;
  /** The status NAME the issue landed in — what a rule is keyed by. */
  toStatus: string;
  /** Jira's id for this changelog entry: the transition's identity. */
  changelogId: string;
}

/**
 * The status change a Jira webhook payload reports, or null when the event is
 * not one (a comment, a field edit, an unrelated event type).
 */
export function parseWebhookTransition(
  payload: unknown,
): IssueTransition | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as {
    webhookEvent?: unknown;
    issue?: { id?: unknown; key?: unknown };
    changelog?: {
      id?: unknown;
      items?: Array<{ field?: unknown; toString?: unknown }>;
    };
  };
  if (p.webhookEvent !== "jira:issue_updated") return null;
  const issueId = p.issue?.id;
  const issueKey = p.issue?.key;
  const changelogId = p.changelog?.id;
  if (
    (typeof issueId !== "string" && typeof issueId !== "number") ||
    typeof issueKey !== "string" ||
    (typeof changelogId !== "string" && typeof changelogId !== "number")
  ) {
    return null;
  }
  const status = p.changelog?.items?.find((item) => item.field === "status");
  if (!status || typeof status.toString !== "string") return null;
  return {
    issueId: String(issueId),
    issueKey,
    toStatus: status.toString,
    changelogId: String(changelogId),
  };
}

/**
 * Every status change on an issue since `since`, oldest first — what the poll
 * reads off a search expanded with the changelog. The same shape the webhook
 * yields, so both feed one fence.
 */
export function transitionsFromChangelog(
  issue: { id: string; key: string },
  histories: readonly JiraChangelogHistory[],
  since: Date,
): IssueTransition[] {
  const out: IssueTransition[] = [];
  for (const history of histories) {
    if (new Date(history.created).getTime() < since.getTime()) continue;
    const status = history.items.find((item) => item.field === "status");
    if (!status || typeof status.toString !== "string") continue;
    out.push({
      issueId: issue.id,
      issueKey: issue.key,
      toStatus: status.toString,
      changelogId: history.id,
    });
  }
  return out.sort((a, b) => Number(a.changelogId) - Number(b.changelogId));
}

export type TriggerOutcome = "started" | "no_rule" | "duplicate" | "disabled";

/** What the run is told first when the rule has no prompt of its own. */
const DEFAULT_JIRA_INSTRUCTION =
  "A Jira issue was moved into a column you are responsible for. Work the issue.";

/** Appended to every Jira-triggered run: the board tools are absent on
 *  purpose, and the issue is the thing to keep up to date. */
const JIRA_RUN_FOOTER = [
  "This run was started by a Jira issue, not a board card. Keep the ISSUE up to date, not a Studio card:",
  "- `JIRA_ISSUE_GET` re-reads the issue (description, comments, attachments).",
  "- `JIRA_COMMENT_ADD` posts a comment on it (markdown). Leave one when you finish, with what you did and any pull request link.",
  "- `JIRA_ISSUE_TRANSITION` moves it to another status when your work warrants it.",
  "- `JIRA_ATTACHMENT_DOWNLOAD` fetches an attachment into the sandbox by its id.",
].join("\n");

function jiraRunTitle(issue: { key: string; summary: string }): string {
  return `Jira ${issue.key}: ${issue.summary}`;
}

/**
 * Dispatch a run for `transition` if the org has a rule for its status and
 * nothing dispatched this transition already.
 */
export async function triggerRunForTransition(
  ctx: StudioContext,
  integration: OrgJiraIntegration,
  transition: IssueTransition,
): Promise<TriggerOutcome> {
  if (!integration.enabled) return "disabled";
  const orgId = integration.organizationId;
  const rule = await ctx.storage.jiraIntegrations.getAutomation(
    orgId,
    transition.toStatus,
  );
  if (!rule) return "no_rule";

  const client = new JiraClient(
    integration.siteUrl,
    integration.email,
    integration.apiToken,
  );
  const issue = await loadIssueForPrompt(
    client,
    integration.siteUrl,
    transition.issueId,
  );
  const item = await ensureAnchorItem(ctx, integration, transition, issue);

  const claimed = await ctx.storage.jiraIntegrations.claimTrigger(
    orgId,
    transition.issueId,
    transition.changelogId,
  );
  if (!claimed) return "duplicate";

  const delegated = await ctx.storage.taskBoard.update(
    item.id,
    orgId,
    {
      assigneeId: SUPER_AGENT_ASSIGNEE_ID,
      assignedBy: integration.createdBy,
    },
    integration.createdBy,
  );
  try {
    await enqueueSuperAgentForTask(ctx, delegated, {
      instruction: rule.prompt ?? DEFAULT_JIRA_INSTRUCTION,
      source: {
        kind: "jira",
        issueKey: issue.key,
        title: jiraRunTitle(issue),
        body: `${renderIssueForPrompt(issue)}\n\n${JIRA_RUN_FOOTER}`,
      },
    });
  } catch (err) {
    // Nothing dispatched: leave the anchor unowned rather than assigned to an
    // agent that will never run. The claim stands — the transition is spent,
    // and the caller's log is the record of why.
    await ctx.storage.taskBoard
      .unassignSuperAgent(item.id, orgId, integration.createdBy)
      .catch(() => {});
    throw err;
  }
  return "started";
}

/**
 * The board item a Jira issue's runs hang off. One per issue, created the
 * first time a rule fires for it and reused after; hidden from the board by
 * `source`, titled by the issue so the monitoring history reads.
 */
async function ensureAnchorItem(
  ctx: StudioContext,
  integration: OrgJiraIntegration,
  transition: IssueTransition,
  issue: IssueForPrompt,
): Promise<TaskBoardItem> {
  const orgId = integration.organizationId;
  const title = `${issue.key}: ${issue.summary}`;
  const linked = await ctx.storage.jiraIntegrations.getLinkByIssueId(
    orgId,
    transition.issueId,
  );
  if (linked) {
    const existing = await ctx.storage.taskBoard.getById(linked.itemId, orgId);
    if (existing) {
      return existing.title === title
        ? existing
        : ctx.storage.taskBoard.update(
            existing.id,
            orgId,
            { title },
            integration.createdBy,
          );
    }
  }
  const created = await ctx.storage.taskBoard.create({
    organizationId: orgId,
    title,
    status: LANES.progress,
    source: "jira",
    externalKey: issue.key,
    externalUrl: issueUrl(integration.siteUrl, issue.key),
    by: integration.createdBy,
  });
  await ctx.storage.jiraIntegrations.createLink({
    itemId: created.id,
    organizationId: orgId,
    jiraIssueId: transition.issueId,
    jiraIssueKey: issue.key,
  });
  return created;
}
