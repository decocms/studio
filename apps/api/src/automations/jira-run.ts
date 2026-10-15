/**
 * An automation fire that carries Jira issues runs on them, as the board's own
 * run (`enqueueSuperAgentForTask`) on a hidden anchor item. Studio keeps no
 * copy of the issue: the anchor exists so quota, pull requests and review keep
 * working, the issue's content goes straight into the run's opening message,
 * and the agent updates the issue itself with the Jira tools its run is
 * served.
 *
 * A fire on one issue reuses the issue's anchor, continues the open pull
 * request the issue links (as a card's run continues the card's), and takes
 * over a run still working that issue. A manual fire on several issues worked
 * together gets an anchor of its own and starts fresh.
 */

import { sleep } from "@decocms/shared/std";
import { LANES, SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import type { StudioContext } from "@/core/studio-context";
import { JiraClient } from "@/jira/client";
import {
  type IssueForPrompt,
  issueUrl,
  loadIssueForPrompt,
  renderIssueForPrompt,
  renderIssuesForPrompt,
  type StatusMove,
} from "@/jira/issue-prompt";
import { openPrForIssue } from "@/jira/open-pr";
import type { TaskBoardStorage } from "@/storage/task-board";
import { getSettings } from "@/settings";
import type {
  Automation,
  OrgJiraIntegration,
  TaskBoardItem,
} from "@/storage/types";
import {
  type ContinuedPullRequest,
  enqueueSuperAgentForTask,
} from "@/tools/task-board/enqueue-super-agent";
import {
  supersedeLiveRuns,
  threadsToSupersede,
} from "@/tools/task-board/rerun";
import {
  automationInstruction,
  cardFireFence,
} from "./board-column-transition";
import { type RunError, runErrorOf } from "./card-run";

/** The issues a fire runs on. */
export interface JiraTarget {
  kind: "jira";
  /** Issue keys or ids. More than one only when a person asked for them to
   *  be worked together in one run. */
  issues: string[];
  /** The settled move that fired it; absent for a manual fire. */
  move?: StatusMove;
  /** Keys the run with the trigger, so a retried fire starts it once: the
   *  changelog entry, or a manual fire's own id. */
  eventKey: string;
  /** Set when a person asked for this run: it runs even with the
   *  automation off, belongs to them rather than to the automation's
   *  creator, and its error goes back to them. */
  manual?: { requestedBy: string };
}

export type JiraRunSkip = "jira_disconnected" | "issue_unreadable" | "rejected";

export type JiraRunOutcome =
  | { threadId: string }
  | { skipped: JiraRunSkip; error?: RunError };

/** What the run is told first when the automation has no message. */
const DEFAULT_JIRA_INSTRUCTION =
  "A Jira issue was moved into a column you are responsible for. Work the issue.";

export async function runAutomationOnJira(
  ctx: StudioContext,
  automation: Automation,
  triggerId: string | null,
  target: JiraTarget,
): Promise<JiraRunOutcome> {
  const orgId = automation.organization_id;
  const integration = await ctx.storage.jiraIntegrations.getByOrg(orgId);
  if (!integration) return { skipped: "jira_disconnected" };
  const fence = cardFireFence(triggerId ?? automation.id, target.eventKey);
  // A replayed step must not supersede the run it already started.
  if (await ctx.storage.threads.get(fence.threadId)) {
    return { threadId: fence.threadId };
  }

  const client = new JiraClient(
    integration.siteUrl,
    integration.email,
    integration.apiToken,
  );
  const actorId = target.manual?.requestedBy ?? automation.created_by;
  const issues: IssueForPrompt[] = [];
  for (const key of target.issues) {
    try {
      issues.push(await loadIssueForPrompt(client, integration.siteUrl, key));
    } catch (err) {
      console.warn(
        `[automations] "${automation.name}" could not read Jira issue ${key}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  const [first] = issues;
  if (!first) return { skipped: "issue_unreadable" };

  let item: TaskBoardItem;
  let run: Pick<JiraDispatch, "issueKeys" | "title" | "body" | "pr">;
  if (issues.length === 1) {
    item = await ensureAnchorItem(ctx, integration, first, actorId);
    if (target.move && (await movedByIntegration(client, target.move))) {
      item = await awaitHandoff(ctx, item);
    }
    const pr = getSettings().taskBoardRerunReusesPrBranch
      ? await openPrForIssue(ctx, orgId, client, first.key)
      : null;
    // Two agents on one issue would each comment and open their own pull request.
    await supersedeLiveRuns(
      ctx,
      item,
      `Stopped: "${automation.name}" started on this issue`,
    );
    run = {
      issueKeys: [first.key],
      title: `Jira ${first.key}: ${first.summary}`,
      body: renderIssueForPrompt(first, target.move),
      ...(pr ? { pr } : {}),
    };
  } else {
    const keys = issues.map((issue) => issue.key);
    item = await ctx.storage.taskBoard.create({
      organizationId: orgId,
      title: batchTitle(keys),
      status: LANES.progress,
      source: "jira",
      by: actorId,
    });
    run = {
      issueKeys: keys,
      title: `Jira ${batchTitle(keys)}`,
      body: renderIssuesForPrompt(issues),
    };
  }

  try {
    await dispatchJiraRun(ctx, item, {
      ...run,
      instruction:
        automationInstruction(automation.messages) || DEFAULT_JIRA_INSTRUCTION,
      actorId,
      userInitiated: target.manual !== undefined,
      automation: {
        name: automation.name,
        agentId: automation.virtual_mcp_id,
        ...(triggerId ? { triggerId } : {}),
        fence,
      },
    });
  } catch (err) {
    console.warn(
      `[automations] "${automation.name}" on Jira ${run.issueKeys.join(", ")} was not dispatched:`,
      err instanceof Error ? err.message : err,
    );
    return { skipped: "rejected", error: runErrorOf(err) };
  }
  return { threadId: fence.threadId };
}

/**
 * The integration's own Jira account made the move: a run moved the issue as
 * its last step, handing it to the next status. A person moving it does not
 * count, even onto the same status.
 */
export async function movedByIntegration(
  client: Pick<JiraClient, "myself">,
  move: StatusMove,
): Promise<boolean> {
  if (!move.movedBy) return false;
  try {
    return move.movedBy.accountId === (await client.myself()).accountId;
  } catch {
    return false;
  }
}

/**
 * Let the run that handed the issue over finish before taking it over, so it
 * ends as completed instead of stopped mid-report. Bounded: a run still live
 * after `timeoutMs` is stopped as on any other move.
 */
export async function awaitHandoff(
  ctx: { storage: { taskBoard: Pick<TaskBoardStorage, "getById"> } },
  item: TaskBoardItem,
  { timeoutMs = 5 * 60_000, pollMs = 5_000 } = {},
): Promise<TaskBoardItem> {
  const deadline = Date.now() + timeoutMs;
  let current = item;
  while (threadsToSupersede(current).length > 0 && Date.now() < deadline) {
    await sleep(pollMs);
    current =
      (await ctx.storage.taskBoard.getById(item.id, item.organizationId)) ??
      current;
  }
  return current;
}

/** `OS-1, OS-2, OS-3 (+11)` — enough of the batch to tell it apart. */
function batchTitle(keys: readonly string[]): string {
  const shown = keys.slice(0, 3).join(", ");
  return keys.length > 3 ? `${shown} (+${keys.length - 3})` : shown;
}

interface JiraDispatch {
  instruction: string;
  actorId: string;
  userInitiated: boolean;
  pr?: ContinuedPullRequest;
  /** The issues the run may act on, and what its message opens with. */
  issueKeys: string[];
  title: string;
  /** The issue(s) only: the prompt builder places the instruction and the
   *  reporting rules around it. */
  body: string;
  automation: {
    name: string;
    agentId: string;
    triggerId?: string;
    fence: { threadId: string; workflowID: string };
  };
}

/** Hand the anchor to the Super Agent and enqueue its run. */
async function dispatchJiraRun(
  ctx: StudioContext,
  item: TaskBoardItem,
  opts: JiraDispatch,
): Promise<void> {
  const orgId = item.organizationId;
  const delegated = await ctx.storage.taskBoard.update(
    item.id,
    orgId,
    { assigneeId: SUPER_AGENT_ASSIGNEE_ID, assignedBy: opts.actorId },
    opts.actorId,
  );
  try {
    await enqueueSuperAgentForTask(ctx, delegated, {
      instruction: opts.instruction,
      // The anchor sits In Progress, but its rule is the automation's, not a lane's.
      column: null,
      ...(opts.userInitiated ? { userInitiated: true } : {}),
      ...(opts.pr ? { pr: opts.pr } : {}),
      source: {
        kind: "jira",
        issueKeys: opts.issueKeys,
        title: opts.title,
        body: opts.body,
      },
      automation: opts.automation,
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
