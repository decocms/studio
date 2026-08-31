/**
 * Jira → task board pull sync (one integration = one org, one board).
 *
 * Scope is the board's saved filter — everything the board is about, INCLUDING
 * its Backlog tab. It used to be `/board/{id}/issue` minus
 * `/board/{id}/backlog`, i.e. only the cards visible in the board's columns,
 * which meant an issue filed and left in the backlog never reached the task
 * board at all (and, because a skipped issue still advances the watermark,
 * never would until someone touched it again). Which sprint an issue is in is
 * now data on the card — {@link TaskBoardItem.sprintId}, mirrored into
 * `task_board_sprints` — so the board can be read one sprint at a time the way
 * Jira's is, without membership deciding whether a card exists.
 *
 * Incremental by watermark: each run pulls issues `updated` since
 * `last_synced_at` (with overlap), ordered ascending, capped per run — a
 * truncated run advances the watermark only as far as it processed, so the
 * next tick resumes where it stopped. Issues whose Jira status has no entry
 * in the tenant's `status_mapping` are skipped entirely; mapped issues are
 * created as board cards or updated in place via `task_board_item_jira_links`.
 *
 * Issue fields are pull-only (creation is pushed the other way — see
 * `jiraIssueCreateWorkflow`); comments are 2-way — comments.ts pushes,
 * `pullComments` here imports. A card deleted on the board reappears only when
 * its issue is next updated in Jira.
 */

import { orgFlagEnabled } from "@decocms/shared/organization/schema";
import {
  boardAutomationFor,
  boardFor,
  boardCan,
  boardLanes,
} from "@/tools/task-board/board-handler";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import type { StudioContext } from "@/core/studio-context";
import type {
  OrgJiraIntegration,
  TaskBoardItem,
  TaskBoardItemPriority,
} from "@/storage/types";
import { reactToSuperAgentDelegation } from "@/tools/task-board/enqueue-super-agent";
import { emitTaskBoardUpdated } from "@/tools/task-board/run-reactions";
import { laneIndex } from "@decocms/shared/jira-status-mapping";
import {
  collectMentionAccountIds,
  jiraBodyToText,
  JiraClient,
  JiraUserDirectory,
  type JiraIssue,
} from "./client";
import { type JiraSprintRef, pickIssueSprint } from "./sprint-field";

/** `created_by`/`updated_by` on synced cards. Deliberately NOT "system" —
 *  that marks reports-owned cards and locks their title/description. */
export const JIRA_SYNC_ACTOR = "jira";

/** Bounds one run so a huge first import can't eat a whole cron tick; the
 *  watermark makes the next run resume, so this is pacing, not truncation. */
const MAX_ISSUES_PER_RUN = 500;

/** Re-covers clock skew and same-minute writes around the watermark;
 *  re-fetched issues no-op via the link's `jira_updated_at`. */
const WATERMARK_OVERLAP_MINUTES = 5;

/** Search pages one run will walk. `MAX_ISSUES_PER_RUN` alone cannot bound the
 *  loop: an empty page carrying a token consumes no issue budget. */
const MAX_PAGES_PER_RUN = 25;

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
  /** Cards taken off the board because their issue left the board's scope. */
  archived: number;
  /**
   * Jira statuses the run skipped for having no lane, deduped.
   *
   * The skip itself is by design — a tenant maps the columns they care about —
   * but silently. A board with ten columns and six mapped statuses drifts
   * card by card as work moves into an unmapped one, and nothing said so; this
   * is what the settings UI turns into "these columns aren't mapped".
   */
  unmappedStatuses: string[];
}

export type JiraSyncResult = JiraSyncCounts | { error: string };

/** Sync one integration, folding any failure into `last_sync_error` — never
 *  throws, mirroring `syncOrgRepoSafe`. */
export async function syncJiraIntegrationSafe(
  ctx: StudioContext,
  integration: OrgJiraIntegration,
): Promise<JiraSyncResult> {
  try {
    const { counts, watermark, rescanPending } = await runSync(
      ctx,
      integration,
    );
    await ctx.storage.jiraIntegrations.recordSyncResult(integration.id, {
      error: null,
      watermark,
      rescanPending,
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

/**
 * The pull's query: the board's scope, narrowed by the tenant's extra filter
 * and by the watermark, ordered so a truncated run resumes cleanly.
 *
 * Exported for tests — this string decides which of a customer's issues exist
 * on their board, and the ordering is what makes the watermark meaningful.
 *
 * The elapsed window is clamped at 0: the watermark is Jira's `updated`, on
 * Jira's clock, so it can sit ahead of ours, and a negative window emits
 * `updated >= --25m` — a JQL 400 on every tick until the clocks converge.
 */
/**
 * Make the org's board look like its Jira board, and hand back the reverse
 * index the pull needs: Jira status name → the column that groups it.
 *
 * Both come from the same call. Jira's board configuration already says which
 * statuses live in which column, so the mapping is read rather than
 * configured — and the columns Studio renders are the ones the team sees in
 * Jira, under the names they gave them.
 */
async function mirrorBoardColumns(
  ctx: StudioContext,
  integration: OrgJiraIntegration,
  boardId: string,
): Promise<Map<string, string>> {
  const client = new JiraClient(
    integration.siteUrl,
    integration.email,
    integration.apiToken,
  );
  const columns = await client.getBoardColumns(boardId);
  await ctx.storage.boardColumns.replaceAll(
    integration.organizationId,
    columns.map((column) => ({
      key: column.name,
      title: column.name,
      // The push's whole reason for existing: a column groups several
      // statuses, and only the tracker knows which and in what order.
      trackerStatuses: column.statuses,
    })),
  );
  const index = new Map<string, string>();
  for (const column of columns) {
    // First column wins, as it does for the hand-written mapping: a Jira status
    // in two columns would otherwise make a card's lane depend on iteration.
    for (const status of column.statuses) {
      if (!index.has(status)) index.set(status, column.name);
    }
  }
  return index;
}

/**
 * Whether the pull writes the card's status, or leaves it where it is.
 *
 * Normally only when Jira's own status changed — an unrelated issue edit must
 * not yank back a card the agent already advanced.
 *
 * The exception is a card sitting in a column this board does not have. That
 * is EVERY card on the day an org's board becomes its own: their statuses are
 * Studio's lanes, the columns are suddenly the tracker's, and a card nobody
 * touched in Jira would render nowhere at all. Re-homing is bounded to exactly
 * those cards and stops for each one the moment it lands somewhere real, so it
 * is a conversion path rather than a standing override.
 */
/**
 * Whether the pull writes the card's sprint, or leaves it where it is.
 *
 * Only when Jira's own sprint changed since we last looked, so someone pulling
 * a card into the sprint from Studio is not undone by the next tick reading
 * Jira's not-yet-updated sprint back over them. The pull used to write it
 * unconditionally, which cost nothing while the sync was the only writer.
 *
 * Deliberately NOT the mirror of {@link rewritesStatus}: that one re-homes a
 * card stranded in a column the board does not have, because a card has to be
 * SOMEWHERE. A card in no sprint is in the backlog, which is a real place.
 */
export function rewritesSprint({
  lastSeenJiraSprintId,
  jiraSprintId,
}: {
  /** `jira_sprint_id` on the link: the sprint we last saw or set on Jira. */
  lastSeenJiraSprintId: string | null;
  /** Where the issue is in Jira right now. Null is the backlog. */
  jiraSprintId: string | null;
}): boolean {
  return lastSeenJiraSprintId !== jiraSprintId;
}

export function rewritesStatus({
  jiraStatusChanged,
  currentStatus,
  boardColumns,
}: {
  jiraStatusChanged: boolean;
  /** Null when the card could not be read; nothing to re-home. */
  currentStatus: string | null;
  boardColumns: ReadonlySet<string>;
}): boolean {
  if (jiraStatusChanged) return true;
  return currentStatus !== null && !boardColumns.has(currentStatus);
}

export function buildJql(
  integration: OrgJiraIntegration,
  scopeJql: string,
  now: Date,
): string {
  // Relative-minutes JQL sidesteps JQL's the-user's-timezone date parsing.
  const elapsed = integration.lastSyncedAt
    ? Math.ceil(
        (now.getTime() - new Date(integration.lastSyncedAt).getTime()) / 60_000,
      )
    : null;
  const since =
    elapsed === null ? null : Math.max(0, elapsed) + WATERMARK_OVERLAP_MINUTES;
  const conditions = [
    `(${scopeJql})`,
    // Subtasks are rows on their parent's card, not cards.
    "issuetype IN standardIssueTypes()",
    ...(since !== null ? [`updated >= -${since}m`] : []),
  ].join(" AND ");
  return `${conditions} ORDER BY updated ASC`;
}

/**
 * Whether a linked issue can be skipped without re-reading its fields.
 *
 * Normally yes: the link records the `updated` we last processed, so an issue
 * no newer than that has nothing to tell us, and this shortcut is what keeps a
 * tick cheap.
 *
 * NEVER on a rescan. A rescan happens because the shape of what we mirror
 * changed, which makes every existing card stale by definition — and the
 * shortcut fires BEFORE any field is written, so the rescan would create the
 * cards it was missing and leave every card it already had untouched. That is
 * exactly what happened when sprints shipped: 50 cards arrived, 274 kept a null
 * sprint, and the board showed 253 issues that Jira had in a sprint as backlog.
 */
export function isUnchanged(
  linkUpdatedAt: string,
  issueUpdated: Date,
  isRescan: boolean,
): boolean {
  if (isRescan) return false;
  return new Date(linkUpdatedAt) >= issueUpdated;
}

/**
 * Whether this run stopped short of the full incremental scope — either cap
 * can be why: `MAX_ISSUES_PER_RUN` on a page full of mapped issues, or
 * `MAX_PAGES_PER_RUN` on a filter that returns many empty-but-tokened pages
 * (an issue-sparse JQL still burns a page per call). Shared by every caller
 * that needs to know "did this run actually finish", so the two truncation
 * reasons can't drift apart again.
 */
export function runTruncated(processed: number, pages: number): boolean {
  return processed >= MAX_ISSUES_PER_RUN || pages >= MAX_PAGES_PER_RUN;
}

/**
 * Whether the rescan must keep forcing a full re-read on the NEXT run.
 *
 * A run only advances as far as `MAX_ISSUES_PER_RUN`/`MAX_PAGES_PER_RUN` let
 * it (deliberate pacing, see below) — so a rescan on a board with more mapped
 * issues than one run's cap sets a non-null `last_synced_at` before the scope
 * is fully re-read. Without this, the next run would read `lastSyncedAt !==
 * null`, stop treating itself as a rescan, and silently go back to
 * `isUnchanged`'s shortcut for every issue the first run never reached — the
 * same bug migration 185 fixed, just past the 500-issue mark instead of at
 * `updated === lastSyncedAt`.
 */
export function rescanContinues(
  isRescan: boolean,
  processed: number,
  pages: number,
): boolean {
  return isRescan && runTruncated(processed, pages);
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
  if (item.assigneeId) return item;
  const orgId = integration.organizationId;
  // The board decides: a column with no rule on it is uneventful. This is also
  // what replaced `integration.autoDelegate`, which could only ever mean the
  // Super Agent, on To Do, for an org that had Jira.
  const automation = await boardAutomationFor(ctx, orgId, item.status);
  if (!automation) return item;
  // Conditional claim, not a plain update: the cron, a webhook wake-up (its
  // debounce is per-pod) and a manual JIRA_SYNC_RUN can all be mid-sync on the
  // same issue, and a read-then-write would dispatch two paid agent runs on it.
  const queue = (await boardLanes(ctx, orgId)).queue;
  if (
    !boardCan(orgId, "todo", queue, "auto-delegating Jira issues to the agent")
  ) {
    return item;
  }
  const delegated = await ctx.storage.taskBoard.claimUnassignedForSuperAgent(
    item.id,
    orgId,
    integration.createdBy,
    JIRA_SYNC_ACTOR,
    queue,
  );
  if (!delegated) return item;
  await ctx.storage.taskBoard.recordActivity({
    taskBoardItemId: item.id,
    action: "assignee_changed",
    actorId: null,
    data: { from: null, to: SUPER_AGENT_ASSIGNEE_ID },
  });
  try {
    await reactToSuperAgentDelegation(ctx, delegated, {
      instruction: automation.prompt ?? undefined,
    });
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

/**
 * Jira sprint id → local sprint id.
 *
 * Seeded from the BOARD's sprints, in one write, before any issue is read —
 * that is what keeps a sprint's name and state current when no issue in it
 * changed, and it means the sprint filter offers the board's sprints even on a
 * tick that imports nothing. Deriving the mirror from issues alone left a
 * sprint that finished in Jira reading as the running one indefinitely.
 *
 * `localIdFor` still upserts on a miss: an issue can carry a sprint from
 * another board (a shared project, a moved issue), and a card must not lose
 * its sprint just because this board never heard of it.
 */
class JiraSprintMirror {
  private readonly ids = new Map<string, string>();

  constructor(
    private readonly ctx: StudioContext,
    private readonly organizationId: string,
  ) {}

  async seed(refs: readonly JiraSprintRef[]): Promise<void> {
    if (refs.length === 0) return;
    const mirrored = await this.ctx.storage.sprints.upsertManyFromJira(
      this.organizationId,
      refs.map(toUpsert),
    );
    for (const [jiraId, localId] of mirrored) this.ids.set(jiraId, localId);
  }

  async localIdFor(ref: JiraSprintRef | null): Promise<string | null> {
    if (!ref) return null;
    const known = this.ids.get(ref.id);
    if (known) return known;
    const id = await this.ctx.storage.sprints.upsertFromJira(
      this.organizationId,
      toUpsert(ref),
    );
    this.ids.set(ref.id, id);
    return id;
  }
}

function toUpsert(ref: JiraSprintRef) {
  return {
    jiraSprintId: ref.id,
    name: ref.name,
    state: ref.state,
    startsAt: ref.startsAt,
    endsAt: ref.endsAt,
  };
}

/**
 * Archive cards whose Jira issue is no longer in the board's scope.
 *
 * The pull is incremental, so absence is the one thing it can never notice: an
 * issue deleted, archived, moved to another project or re-typed out of scope
 * simply stops being mentioned, and its card sat on the board forever showing
 * whatever it last said. On one real board that was six cards, four of them
 * deleted in Jira days earlier.
 *
 * Archived, never deleted: the card carries comments, agent runs and a
 * timeline that the Jira issue's fate says nothing about. `archived` is
 * already the board's hidden lane, so this takes the card off the board while
 * leaving every way back.
 *
 * Two guards, because this writes to a customer's board off the ABSENCE of
 * data: the scope read must be complete (`searchIssueIds` throws rather than
 * truncate) and it must be non-empty — a filter that legitimately matches
 * nothing is indistinguishable from one that broke, so nothing is archived
 * either way.
 */
/**
 * Which linked cards to take off the board, given the scope Jira just reported.
 *
 * Separate and pure because it is the one place that acts on the ABSENCE of
 * data: an empty scope yields nothing rather than the whole board, since a
 * filter that legitimately matches nothing is indistinguishable from a filter
 * that broke, a permission that was revoked, or a project that was renamed.
 */
export function vanishedLinks<T extends { jiraIssueId: string }>(
  liveIssueIds: ReadonlySet<string>,
  linked: readonly T[],
): T[] {
  if (liveIssueIds.size === 0) return [];
  return linked.filter((link) => !liveIssueIds.has(link.jiraIssueId));
}

async function reconcileVanishedIssues(
  ctx: StudioContext,
  integration: OrgJiraIntegration,
  client: JiraClient,
  scopeJql: string,
): Promise<number> {
  const orgId = integration.organizationId;
  const live = await client.searchIssueIds(
    `(${scopeJql}) AND issuetype IN standardIssueTypes()`,
  );
  if (live.size === 0) {
    console.warn(
      `[jira] scope for org ${orgId} came back empty — skipping reconciliation rather than archiving the whole board`,
    );
    return 0;
  }
  const vanished = vanishedLinks(
    live,
    await ctx.storage.jiraIntegrations.listLinkedIssuesOnBoard(orgId),
  );
  if (vanished.length === 0) return 0;

  for (const link of vanished) {
    const before = await ctx.storage.taskBoard.getById(link.itemId, orgId);
    if (!before || before.status === "archived") continue;
    const item = await ctx.storage.taskBoard.update(
      link.itemId,
      orgId,
      { status: "archived" },
      JIRA_SYNC_ACTOR,
    );
    await ctx.storage.taskBoard.recordActivity({
      taskBoardItemId: link.itemId,
      action: "status_changed",
      actorId: null,
      data: { from: before.status, to: "archived" },
    });
    emitTaskBoardUpdated(orgId, item);
    console.log(
      `[jira] ${link.jiraIssueKey} is no longer in board ${integration.boardId}'s scope — archived its card`,
    );
  }
  return vanished.length;
}

async function runSync(
  ctx: StudioContext,
  integration: OrgJiraIntegration,
): Promise<{
  counts: JiraSyncCounts;
  watermark?: Date;
  rescanPending?: boolean;
}> {
  const orgId = integration.organizationId;
  const boardId = integration.boardId;
  if (!boardId) {
    throw new Error("No Jira board selected");
  }
  const settings = await ctx.storage.organizationSettings.get(
    integration.organizationId,
  );
  const orgOwnedColumns = orgFlagEnabled(settings?.flags, "org_board_columns");

  // One reverse index for the whole sync rather than a scan per issue. On a
  // board the org owns it is DERIVED from the board's own configuration —
  // Jira already knows which statuses each of its columns groups, so asking
  // anyone to restate that by hand was the mapping screen's whole mistake.
  const board = await boardFor(ctx, integration.organizationId);
  const laneOf = orgOwnedColumns
    ? await mirrorBoardColumns(ctx, integration, boardId)
    : laneIndex(integration.statusMapping);
  // Read AFTER the mirror, or the first sync of a converting board would see
  // no columns at all and call every card stranded — right by accident, and
  // wrong the moment a board legitimately has none.
  const columnKeys = new Set((await board.columns()).map((c) => c.key));
  if (laneOf.size === 0) {
    throw new Error(
      orgOwnedColumns
        ? "This Jira board has no columns to mirror"
        : "No status mapping configured",
    );
  }

  // First connect / scope change (migration 184) or an unfinished rescan (migration 186).
  const isRescan =
    integration.lastSyncedAt === null || integration.rescanPending;
  const client = new JiraClient(
    integration.siteUrl,
    integration.email,
    integration.apiToken,
  );
  // The integration account's own comments are echoes of our pushes.
  const { accountId: integrationAccountId } = await client.myself();
  const users = new JiraUserDirectory(client);
  const runStartedAt = new Date();
  const scopeJql = await client.getBoardScopeJql(boardId);
  const jql = buildJql(integration, scopeJql, runStartedAt);
  const sprints = new JiraSprintMirror(ctx, orgId);
  await sprints.seed(await client.listBoardSprints(boardId));
  const counts: JiraSyncCounts = {
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    archived: 0,
    unmappedStatuses: [],
  };
  const unmapped = new Set<string>();
  let watermark: Date | undefined;
  let nextPageToken: string | undefined;
  let processed = 0;
  let pages = 0;

  while (processed < MAX_ISSUES_PER_RUN && pages < MAX_PAGES_PER_RUN) {
    pages++;
    const page = await client.searchIssues({ jql, nextPageToken });
    // Read before the empty check — an empty page can still carry a token.
    nextPageToken = page.nextPageToken ?? undefined;
    if (page.issues.length === 0) {
      if (!nextPageToken) break;
      continue;
    }

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

      const status = laneOf.get(issue.fields.status.name);
      if (!status || !isCardIssue(issue)) {
        if (!status && isCardIssue(issue)) {
          unmapped.add(issue.fields.status.name);
        }
        counts.skipped++;
        watermark = issueUpdated;
        continue;
      }

      const link = links.get(issue.id);
      if (link && isUnchanged(link.jiraUpdatedAt, issueUpdated, isRescan)) {
        counts.unchanged++;
        watermark = issueUpdated;
        continue;
      }

      const jiraStatusName = issue.fields.status.name;
      const jiraSprint = pickIssueSprint(issue.sprints);
      const fields = {
        title: issue.fields.summary,
        description: await cardDescription(integration.siteUrl, issue, users),
        priority: mapPriority(issue),
        // Asked of the board, not recomputed from the flag: one answer for
        // every writer, so a card cannot be guarded by one path and not by
        // another. A card the sync has not reached yet stays unguarded rather
        // than wrong, which is what makes adopting the key incremental.
        boardColumnOrg: board.columnOwner(),
      };

      if (link) {
        // Status applies only when it changed ON JIRA'S SIDE, so an unrelated issue edit can't yank back a card the agent already advanced.
        const statusChangedOnJira = link.jiraStatus !== jiraStatusName;
        // Sprint gets the same guard for the same reason: someone pulling a
        // card into the sprint from Studio must not have it undone by the next
        // tick reading Jira's not-yet-updated sprint back over them.
        const sprintChangedOnJira = rewritesSprint({
          lastSeenJiraSprintId: link.jiraSprintId,
          jiraSprintId: jiraSprint?.id ?? null,
        });
        const before = await ctx.storage.taskBoard.getById(link.itemId, orgId);
        const writeStatus = rewritesStatus({
          jiraStatusChanged: statusChangedOnJira,
          currentStatus: before?.status ?? null,
          boardColumns: columnKeys,
        });
        let item = await ctx.storage.taskBoard.update(
          link.itemId,
          orgId,
          {
            ...fields,
            ...(writeStatus ? { status } : {}),
            ...(sprintChangedOnJira
              ? { sprintId: await sprints.localIdFor(jiraSprint) }
              : {}),
          },
          JIRA_SYNC_ACTOR,
        );
        await ctx.storage.jiraIntegrations.touchLink(link.itemId, {
          jiraStatus: jiraStatusName,
          jiraSprintId: jiraSprint?.id ?? null,
        });
        if (before && writeStatus && before.status !== status) {
          await ctx.storage.taskBoard.recordActivity({
            taskBoardItemId: link.itemId,
            action: "status_changed",
            actorId: null,
            data: { from: before.status, to: status },
          });
        }
        if (statusChangedOnJira && !isRescan) {
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
          sprintId: await sprints.localIdFor(jiraSprint),
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
            jiraSprintId: jiraSprint?.id ?? null,
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
        if (!isRescan) {
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

    if (!nextPageToken) break;
  }

  counts.unmappedStatuses = [...unmapped].sort();
  // Reconciliation reads the WHOLE scope, so it waits for a run that actually finished the incremental pass.
  const truncated = runTruncated(processed, pages);
  if (!truncated) {
    counts.archived = await reconcileVanishedIssues(
      ctx,
      integration,
      client,
      scopeJql,
    );
  }

  // A run that legitimately saw nothing still has to set the watermark, or
  // `last_synced_at` stays NULL: the UI would sit on "waiting for the first
  // sync" forever and every later run would count as the initial import, which
  // is exactly the state that suppresses auto-delegation.
  const rescanPending = isRescan && truncated;
  if (watermark === undefined && processed === 0) {
    return { counts, watermark: runStartedAt, rescanPending };
  }

  return { counts, watermark, rescanPending };
}
