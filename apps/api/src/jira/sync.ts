/**
 * Jira → task board pull sync (one integration = one org, one project).
 *
 * Incremental by watermark: each run pulls issues `updated` since
 * `last_synced_at` (with overlap), ordered ascending, capped per run — a
 * truncated run advances the watermark only as far as it processed, so the
 * next tick resumes where it stopped. Issues whose Jira status has no entry
 * in the tenant's `status_mapping` are skipped entirely; mapped issues are
 * created as board cards or updated in place via `task_board_item_jira_links`.
 *
 * Issue fields are pull-only (writes are the future push phase); comments are 2-way — comments.ts pushes, `pullComments` here imports. A card deleted on the board reappears only when its issue is next updated in Jira.
 */

import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import type { StudioContext } from "@/core/studio-context";
import type {
  OrgJiraIntegration,
  TaskBoardItem,
  TaskBoardItemPriority,
  TaskBoardItemStatus,
} from "@/storage/types";
import { reactToSuperAgentDelegation } from "@/tools/task-board/enqueue-super-agent";
import { emitTaskBoardUpdated } from "@/tools/task-board/run-reactions";
import {
  collectMentionAccountIds,
  jiraBodyToText,
  JiraClient,
  JiraUserDirectory,
  type JiraIssue,
} from "./client";

/** `created_by`/`updated_by` on synced cards. Deliberately NOT "system" —
 *  that marks reports-owned cards and locks their title/description. */
export const JIRA_SYNC_ACTOR = "jira";

/** Bounds one run so a huge first import can't eat a whole cron tick; the
 *  watermark makes the next run resume, so this is pacing, not truncation. */
const MAX_ISSUES_PER_RUN = 500;

/** Re-covers clock skew and same-minute writes around the watermark;
 *  re-fetched issues no-op via the link's `jira_updated_at`. */
const WATERMARK_OVERLAP_MINUTES = 5;

const MAX_DESCRIPTION_CHARS = 10_000;

/** Jira's default priority scheme → board priority. Unknown names → medium. */
const PRIORITY_MAP: Record<string, TaskBoardItemPriority> = {
  highest: "urgent",
  high: "high",
  medium: "medium",
  low: "low",
  lowest: "low",
};

export interface JiraSyncCounts {
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
}

export type JiraSyncResult = JiraSyncCounts | { error: string };

/** Sync one integration, folding any failure into `last_sync_error` — never
 *  throws, mirroring `syncOrgRepoSafe`. */
export async function syncJiraIntegrationSafe(
  ctx: StudioContext,
  integration: OrgJiraIntegration,
): Promise<JiraSyncResult> {
  try {
    const { counts, watermark } = await runSync(ctx, integration);
    await ctx.storage.jiraIntegrations.recordSyncResult(integration.id, {
      error: null,
      watermark,
    });
    return counts;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.storage.jiraIntegrations
      .recordSyncResult(integration.id, { error: message })
      .catch(() => {});
    return { error: message };
  }
}

function buildJql(integration: OrgJiraIntegration): string {
  // Relative-minutes JQL sidesteps JQL's the-user's-timezone date parsing.
  const since = integration.lastSyncedAt
    ? Math.ceil(
        (Date.now() - new Date(integration.lastSyncedAt).getTime()) / 60_000,
      ) + WATERMARK_OVERLAP_MINUTES
    : null;
  const conditions = [
    // Scope comes from the board itself; this only kills subtasks server-side.
    "issuetype IN standardIssueTypes()",
    ...(integration.jqlFilter?.trim()
      ? [`(${integration.jqlFilter.trim()})`]
      : []),
    ...(since !== null ? [`updated >= -${since}m`] : []),
  ].join(" AND ");
  return `${conditions} ORDER BY updated ASC`;
}

/** Epics (hierarchyLevel 1) and anything above are containers, not cards. */
function isCardIssue(issue: JiraIssue): boolean {
  const level = issue.fields.issuetype?.hierarchyLevel;
  return typeof level !== "number" || level === 0;
}

async function cardDescription(
  siteUrl: string,
  issue: JiraIssue,
  users: JiraUserDirectory,
): Promise<string> {
  const body = issue.fields.description;
  const names = await users.resolve(collectMentionAccountIds(body));
  const text = jiraBodyToText(body, names);
  return `${siteUrl}/browse/${issue.key}\n\n${text}`
    .trim()
    .slice(0, MAX_DESCRIPTION_CHARS);
}

function mapPriority(issue: JiraIssue): TaskBoardItemPriority {
  const name = issue.fields.priority?.name?.toLowerCase();
  return (name && PRIORITY_MAP[name]) || "medium";
}

/** The Jira-driven agent trigger: an unassigned card that just landed in the
 *  To Do lane gets the Super Agent, running under the integration's creator
 *  (`enqueueAgentRunForTask` acts as the card's `assigned_by`). A quota
 *  rejection un-delegates — import-route precedent — instead of leaving a
 *  card assigned-but-never-running. */
async function maybeAutoDelegate(
  ctx: StudioContext,
  integration: OrgJiraIntegration,
  item: TaskBoardItem,
): Promise<TaskBoardItem> {
  if (!integration.autoDelegate) return item;
  if (item.status !== "todo" || item.assigneeId) return item;
  const orgId = integration.organizationId;
  // Conditional claim, not a plain update: the cron, a webhook wake-up (its
  // debounce is per-pod) and a manual JIRA_SYNC_RUN can all be mid-sync on the
  // same issue, and a read-then-write would dispatch two paid agent runs on it.
  const delegated = await ctx.storage.taskBoard.claimUnassignedForSuperAgent(
    item.id,
    orgId,
    integration.createdBy,
    JIRA_SYNC_ACTOR,
  );
  if (!delegated) return item;
  await ctx.storage.taskBoard.recordActivity({
    taskBoardItemId: item.id,
    action: "assignee_changed",
    actorId: null,
    data: { from: null, to: SUPER_AGENT_ASSIGNEE_ID },
  });
  try {
    await reactToSuperAgentDelegation(ctx, delegated);
  } catch (err) {
    console.warn(
      `[jira] auto-delegate of ${item.id} rejected, un-delegating:`,
      err instanceof Error ? err.message : err,
    );
    return await ctx.storage.taskBoard.update(
      item.id,
      orgId,
      { assigneeId: null, assignedBy: null },
      JIRA_SYNC_ACTOR,
    );
  }
  return delegated;
}

/** Import a changed issue's comments not yet on the card. The link table is
 *  the echo/idempotency cut (our own pushes and prior pulls are linked); the
 *  author check is a belt-and-braces for a push whose link write failed. */
async function pullComments(
  ctx: StudioContext,
  integration: OrgJiraIntegration,
  client: JiraClient,
  issue: JiraIssue,
  itemId: string,
  integrationAccountId: string,
  users: JiraUserDirectory,
): Promise<void> {
  const orgId = integration.organizationId;
  const embedded = issue.fields.comment;
  if (embedded && embedded.total === 0) return;
  const comments =
    embedded && embedded.comments.length >= embedded.total
      ? embedded.comments
      : await client.listComments(issue.id);
  const known = await ctx.storage.jiraIntegrations.knownJiraCommentIds(
    orgId,
    comments.map((comment) => comment.id),
  );
  const pending = comments.filter(
    (comment) =>
      !known.has(comment.id) &&
      comment.author?.accountId !== integrationAccountId,
  );
  if (pending.length === 0) return;
  // One lookup for the whole batch, not one per comment.
  const names = await users.resolve(
    pending.flatMap((comment) => collectMentionAccountIds(comment.body)),
  );
  for (const comment of pending) {
    const text = jiraBodyToText(comment.body, names).slice(
      0,
      MAX_DESCRIPTION_CHARS,
    );
    const created = await ctx.storage.taskBoard.createComment({
      taskBoardItemId: itemId,
      organizationId: orgId,
      authorId: JIRA_SYNC_ACTOR,
      body: `**${comment.author?.displayName ?? "Jira"} · via Jira:**\n\n${text}`,
    });
    if (!created) continue;
    try {
      await ctx.storage.jiraIntegrations.createCommentLink({
        commentId: created.id,
        organizationId: orgId,
        jiraCommentId: comment.id,
      });
    } catch (err) {
      // 23505: a concurrent run imported it first — drop our duplicate.
      if ((err as { code?: string }).code === "23505") {
        await ctx.storage.taskBoard.deleteComment(
          created.id,
          orgId,
          JIRA_SYNC_ACTOR,
        );
        continue;
      }
      throw err;
    }
  }
}

async function runSync(
  ctx: StudioContext,
  integration: OrgJiraIntegration,
): Promise<{ counts: JiraSyncCounts; watermark?: Date }> {
  const orgId = integration.organizationId;
  const boardId = integration.boardId;
  if (!boardId) {
    throw new Error("No Jira board selected");
  }
  const mapping = integration.statusMapping;
  if (Object.keys(mapping).length === 0) {
    throw new Error("No status mapping configured");
  }

  // The first import is a backfill, not activity — never its auto-delegate trigger (it would dispatch one run per pre-existing To Do issue).
  const isInitialImport = integration.lastSyncedAt === null;
  const client = new JiraClient(
    integration.siteUrl,
    integration.email,
    integration.apiToken,
  );
  // The integration account's own comments are echoes of our pushes.
  const { accountId: integrationAccountId } = await client.myself();
  const users = new JiraUserDirectory(client);
  // Backlog-tab issues have normal statuses but are not visible board cards.
  const backlogIds = await client.listBacklogIssueIds(boardId);
  const jql = buildJql(integration);
  const counts: JiraSyncCounts = {
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
  };
  let watermark: Date | undefined;
  let startAt = 0;
  let processed = 0;
  const runStartedAt = new Date();

  while (processed < MAX_ISSUES_PER_RUN) {
    const page = await client.listBoardIssues({ boardId, jql, startAt });
    if (page.issues.length === 0) break;
    startAt += page.issues.length;

    const links = await ctx.storage.jiraIntegrations.getLinksByIssueIds(
      orgId,
      page.issues.map((issue) => issue.id),
    );
    // One name lookup for the page, so the per-issue resolves below are cache
    // hits rather than up to MAX_ISSUES_PER_RUN sequential single-id requests.
    await users.resolve(
      page.issues.flatMap((issue) => [
        ...collectMentionAccountIds(issue.fields.description),
        ...(issue.fields.comment?.comments ?? []).flatMap((comment) =>
          collectMentionAccountIds(comment.body),
        ),
      ]),
    );

    for (const issue of page.issues) {
      if (processed >= MAX_ISSUES_PER_RUN) break;
      processed++;
      const issueUpdated = new Date(issue.fields.updated);
      if (Number.isNaN(issueUpdated.getTime())) {
        throw new Error(`Unparseable updated on ${issue.key}`);
      }

      const status: TaskBoardItemStatus | undefined =
        mapping[issue.fields.status.name];
      if (!status || !isCardIssue(issue) || backlogIds.has(issue.id)) {
        counts.skipped++;
        watermark = issueUpdated;
        continue;
      }

      const link = links.get(issue.id);
      if (link && new Date(link.jiraUpdatedAt) >= issueUpdated) {
        counts.unchanged++;
        watermark = issueUpdated;
        continue;
      }

      const jiraStatusName = issue.fields.status.name;
      const fields = {
        title: issue.fields.summary,
        description: await cardDescription(integration.siteUrl, issue, users),
        priority: mapPriority(issue),
      };

      if (link) {
        // Status applies only when it changed ON JIRA'S SIDE, so an unrelated issue edit can't yank back a card the agent already advanced.
        const statusChangedOnJira = link.jiraStatus !== jiraStatusName;
        const before = await ctx.storage.taskBoard.getById(link.itemId, orgId);
        let item = await ctx.storage.taskBoard.update(
          link.itemId,
          orgId,
          { ...fields, ...(statusChangedOnJira ? { status } : {}) },
          JIRA_SYNC_ACTOR,
        );
        await ctx.storage.jiraIntegrations.touchLink(link.itemId, {
          jiraStatus: jiraStatusName,
        });
        if (before && statusChangedOnJira && before.status !== status) {
          await ctx.storage.taskBoard.recordActivity({
            taskBoardItemId: link.itemId,
            action: "status_changed",
            actorId: null,
            data: { from: before.status, to: status },
          });
        }
        if (statusChangedOnJira && !isInitialImport) {
          item = await maybeAutoDelegate(ctx, integration, item);
        }
        await pullComments(
          ctx,
          integration,
          client,
          issue,
          link.itemId,
          integrationAccountId,
          users,
        );
        // Last, because this is what marks the issue "fully processed": moving
        // it before `pullComments` means a failed comment fetch is never
        // retried — the next run reads the issue as unchanged and those
        // comments are stranded for good.
        await ctx.storage.jiraIntegrations.touchLink(link.itemId, {
          jiraUpdatedAt: issueUpdated,
        });
        emitTaskBoardUpdated(orgId, item);
        counts.updated++;
      } else {
        let item = await ctx.storage.taskBoard.create({
          organizationId: orgId,
          ...fields,
          status,
          by: JIRA_SYNC_ACTOR,
        });
        try {
          await ctx.storage.jiraIntegrations.createLink({
            itemId: item.id,
            organizationId: orgId,
            jiraIssueId: issue.id,
            jiraIssueKey: issue.key,
            // Epoch = "claimed, not yet fully processed". The row has to exist
            // now to win the UNIQUE against a concurrent run, but any value
            // near the issue's own `updated` would make the next run skip it as
            // unchanged even if the comment pull below never finished.
            jiraUpdatedAt: new Date(0),
            jiraStatus: jiraStatusName,
          });
        } catch (err) {
          // 23505: a concurrent run won the link's UNIQUE — drop our orphan card.
          if ((err as { code?: string }).code === "23505") {
            await ctx.storage.taskBoard.delete(item.id, orgId, JIRA_SYNC_ACTOR);
            counts.unchanged++;
            watermark = issueUpdated;
            continue;
          }
          throw err;
        }
        if (!isInitialImport) {
          item = await maybeAutoDelegate(ctx, integration, item);
        }
        await pullComments(
          ctx,
          integration,
          client,
          issue,
          item.id,
          integrationAccountId,
          users,
        );
        await ctx.storage.jiraIntegrations.touchLink(item.id, {
          jiraUpdatedAt: issueUpdated,
        });
        emitTaskBoardUpdated(orgId, item);
        counts.created++;
      }
      watermark = issueUpdated;
    }

    if (startAt >= page.total) break;
  }

  // A run that legitimately saw nothing still has to set the watermark, or
  // `last_synced_at` stays NULL: the UI would sit on "waiting for the first
  // sync" forever and every later run would count as the initial import, which
  // is exactly the state that suppresses auto-delegation.
  if (watermark === undefined && processed === 0) {
    return { counts, watermark: runStartedAt };
  }

  return { counts, watermark };
}
