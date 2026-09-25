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
 *
 * `startJiraRunForIssue` is the same run without any of that gating — a person
 * asking for one issue, which is how a rule gets tried before it is turned on.
 */

import { LANES, SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import type { StudioContext } from "@/core/studio-context";
import type { OrgJiraIntegration, TaskBoardItem } from "@/storage/types";
import {
  type ContinuedPullRequest,
  enqueueSuperAgentForTask,
} from "@/tools/task-board/enqueue-super-agent";
import { openPrForIssue } from "./open-pr";
import { supersedeLiveRuns } from "@/tools/task-board/rerun";
import { JiraClient, type JiraChangelogHistory } from "./client";
import {
  type IssueForPrompt,
  issueUrl,
  loadIssueForPrompt,
  renderIssueForPrompt,
  renderIssuesForPrompt,
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

/** What a run on ONE issue is dispatched with: that issue, in full. */
function oneIssue(issue: IssueForPrompt) {
  return {
    issueKeys: [issue.key],
    title: `Jira ${issue.key}: ${issue.summary}`,
    body: renderIssueForPrompt(issue),
  };
}

function jiraClientFor(integration: OrgJiraIntegration): JiraClient {
  return new JiraClient(
    integration.siteUrl,
    integration.email,
    integration.apiToken,
  );
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

  const client = jiraClientFor(integration);
  const issue = await loadIssueForPrompt(
    client,
    integration.siteUrl,
    transition.issueId,
  );
  const item = await ensureAnchorItem(
    ctx,
    integration,
    issue,
    integration.createdBy,
  );
  const claimed = await ctx.storage.jiraIntegrations.claimTrigger(
    orgId,
    transition.issueId,
    transition.changelogId,
  );
  if (!claimed) return "duplicate";

  // Resolved after the claim: a redelivered webhook must bail here, not after this network round trip.
  const pr = rule.continuePr
    ? await openPrForIssue(ctx, orgId, client, issue.key)
    : null;

  // Guards against a run still working an earlier transition on this anchor.
  await supersedeLiveRuns(ctx, item);
  // A dispatch failure past here leaves the claim standing: the transition is spent.
  await dispatchJiraRun(ctx, integration, item, {
    instruction: rule.prompt,
    actorId: integration.createdBy,
    ...oneIssue(issue),
    ...(pr ? { pr } : {}),
  });
  return "started";
}

/**
 * Run the agent on ONE issue because a person asked for it — how a status rule
 * gets tried before it is switched on for every issue that enters a column.
 *
 * Deliberately not the trigger: no rule has to exist, the integration does not
 * have to be enabled, and there is no transition to fence, so the same issue
 * can be re-run as many times as the prompt needs rewording without anyone
 * dragging a card around a real board. Everything downstream is identical, so
 * what you watch here is what a rule will do — including that the agent works
 * on the real issue and comments on it.
 */
export async function startJiraRunForIssue(
  ctx: StudioContext,
  integration: OrgJiraIntegration,
  issueKey: string,
  opts: {
    instruction: string | null;
    actorId: string;
    /** Hand the run an EXISTING pull request to continue instead of opening
     *  one — a re-run after a review asked for changes. */
    pr?: ContinuedPullRequest;
  },
): Promise<{
  item: TaskBoardItem;
  issue: IssueForPrompt;
  /** Runs that were failed and stopped to make room for this one. */
  supersededThreadIds: string[];
}> {
  const issue = await loadIssueForPrompt(
    jiraClientFor(integration),
    integration.siteUrl,
    issueKey,
  );
  const item = await ensureAnchorItem(ctx, integration, issue, opts.actorId);
  // Two agents on one issue would each comment and open their own pull request.
  const supersededThreadIds = await supersedeLiveRuns(ctx, item);
  await dispatchJiraRun(ctx, integration, item, {
    instruction: opts.instruction,
    actorId: opts.actorId,
    ...oneIssue(issue),
    ...(opts.pr ? { pr: opts.pr } : {}),
    // A person asked for this run, like a card's Re-run.
    userInitiated: true,
  });
  return { item, issue, supersededThreadIds };
}

/**
 * Run the agent ONCE on several issues because a person asked for it.
 *
 * Not N runs of `startJiraRunForIssue`: the point is work that spans the
 * issues — landing the pull requests of a whole epic in order, say — where
 * one agent needs to see them all. The run is anchored on its own hidden item
 * (there is no one issue for it to hang off), its opening message digests
 * every issue, and its Jira tools take `issueKey` to say which one they act
 * on. Issues that cannot be read are reported, not fatal: one
 * bad key must not cost the rest their run.
 */
export async function startJiraRunForIssues(
  ctx: StudioContext,
  integration: OrgJiraIntegration,
  issueKeys: readonly string[],
  opts: { instruction: string | null; actorId: string },
): Promise<{
  item: TaskBoardItem | null;
  issues: IssueForPrompt[];
  failed: Array<{ issueKey: string; error: string }>;
}> {
  const client = jiraClientFor(integration);
  const issues: IssueForPrompt[] = [];
  const failed: Array<{ issueKey: string; error: string }> = [];
  for (const key of issueKeys) {
    try {
      issues.push(await loadIssueForPrompt(client, integration.siteUrl, key));
    } catch (err) {
      failed.push({
        issueKey: key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (issues.length === 0) return { item: null, issues, failed };

  const keys = issues.map((issue) => issue.key);
  const item = await ctx.storage.taskBoard.create({
    organizationId: integration.organizationId,
    title: batchTitle(keys),
    status: LANES.progress,
    source: "jira",
    by: opts.actorId,
  });
  await dispatchJiraRun(ctx, integration, item, {
    instruction: opts.instruction,
    actorId: opts.actorId,
    userInitiated: true,
    issueKeys: keys,
    title: `Jira ${batchTitle(keys)}`,
    body: renderIssuesForPrompt(issues),
  });
  return { item, issues, failed };
}

/** `OS-1, OS-2, OS-3 (+11)` — enough of the batch to tell it apart. */
function batchTitle(keys: readonly string[]): string {
  const shown = keys.slice(0, 3).join(", ");
  return keys.length > 3 ? `${shown} (+${keys.length - 3})` : shown;
}

/** Hand the anchor to the Super Agent and enqueue its run. */
async function dispatchJiraRun(
  ctx: StudioContext,
  integration: OrgJiraIntegration,
  item: TaskBoardItem,
  opts: {
    instruction: string | null;
    actorId: string;
    userInitiated?: boolean;
    pr?: ContinuedPullRequest;
    /** The issues the run may act on, and what its message opens with. */
    issueKeys: string[];
    title: string;
    body: string;
  },
): Promise<void> {
  const orgId = integration.organizationId;
  const delegated = await ctx.storage.taskBoard.update(
    item.id,
    orgId,
    { assigneeId: SUPER_AGENT_ASSIGNEE_ID, assignedBy: opts.actorId },
    opts.actorId,
  );
  try {
    await enqueueSuperAgentForTask(ctx, delegated, {
      instruction: opts.instruction ?? DEFAULT_JIRA_INSTRUCTION,
      ...(opts.userInitiated ? { userInitiated: true } : {}),
      ...(opts.pr ? { pr: opts.pr } : {}),
      source: {
        kind: "jira",
        issueKeys: opts.issueKeys,
        title: opts.title,
        // The issue(s) only. How to report back is the prompt builder's job —
        // it is the half that knows how this harness namespaces the tools, and
        // it puts the instruction where the model weights it (the end) instead
        // of in the middle of the issue body.
        body: opts.body,
      },
    });
  } catch (err) {
    // Nothing dispatched: leave the anchor unowned, not owned by a phantom run.
    await ctx.storage.taskBoard
      .unassignSuperAgent(item.id, orgId, opts.actorId)
      .catch(() => {});
    throw err;
  }
}

/**
 * The board item a Jira issue's runs hang off. One per issue, created the
 * first time a run fires for it and reused after; hidden from the board by
 * `source`, titled by the issue so the monitoring history reads.
 */
async function ensureAnchorItem(
  ctx: StudioContext,
  integration: OrgJiraIntegration,
  issue: IssueForPrompt,
  actorId: string,
): Promise<TaskBoardItem> {
  const orgId = integration.organizationId;
  const title = `${issue.key}: ${issue.summary}`;
  const linked = await ctx.storage.jiraIntegrations.getLinkByIssueId(
    orgId,
    issue.id,
  );
  if (linked) {
    const existing = await ctx.storage.taskBoard.getById(linked.itemId, orgId);
    if (existing) {
      return existing.title === title
        ? existing
        : ctx.storage.taskBoard.update(existing.id, orgId, { title }, actorId);
    }
  }
  const created = await ctx.storage.taskBoard.create({
    organizationId: orgId,
    title,
    status: LANES.progress,
    source: "jira",
    externalKey: issue.key,
    externalUrl: issueUrl(integration.siteUrl, issue.key),
    by: actorId,
  });
  await ctx.storage.jiraIntegrations.createLink({
    itemId: created.id,
    organizationId: orgId,
    jiraIssueId: issue.id,
    jiraIssueKey: issue.key,
  });
  return created;
}
