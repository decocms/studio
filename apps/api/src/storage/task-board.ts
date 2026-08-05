/**
 * Task Board Storage Implementation
 *
 * Handles CRUD operations for org-scoped task board items, plus the
 * many-to-many link between a task and the agent threads run for it.
 */

import { sql, type Kysely } from "kysely";
// Shared with the quota gate, which charges the same class of task.
import { isReportsTask } from "../billing/task-quota";
import type {
  Database,
  TaskBoardActivity,
  TaskBoardActivityAction,
  TaskBoardItem,
  TaskBoardItemPriority,
  TaskBoardItemPrRef,
  TaskBoardItemStatus,
  TaskBoardItemTagRef,
  TaskBoardItemThreadRef,
} from "./types";
import { generatePrefixedId } from "@decocms/shared/utils/generate-id";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";

/** One comment on a task, as the tools return it. `parentId` null = thread root;
 *  `resolved` only means anything on a root. */
export interface TaskBoardComment {
  id: string;
  taskBoardItemId: string;
  parentId: string | null;
  authorId: string;
  body: string;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A diagnostic finding the org deleted from its board. The import skips these
 *  keys, so the finding stays gone until it's restored. */
export interface DismissedFinding {
  externalKey: string;
  dismissedBy: string;
  dismissedAt: string;
}

function commentFromDbRow(row: {
  id: string;
  task_board_item_id: string;
  parent_id: string | null;
  author_id: string;
  body: string;
  resolved: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}): TaskBoardComment {
  const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : v);
  return {
    id: row.id,
    taskBoardItemId: row.task_board_item_id,
    parentId: row.parent_id,
    authorId: row.author_id,
    body: row.body,
    resolved: row.resolved,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** Text of a folded/persisted text part payload (`{ type: "text", text }`). */
function extractPartText(payload: unknown): string | null {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const text = (payload as { text?: unknown }).text;
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  return null;
}

/** Thread run statuses that mean the run is over (not running / not paused on a
 *  user_ask). `requires_action` and `in_progress` are deliberately excluded. */
export const TERMINAL_THREAD_STATUSES = new Set([
  "completed",
  "failed",
  "expired",
]);

/**
 * Should a task advance to In Review now that a thread finished? True iff it's
 * In Progress, has at least one thread that was actually used, and every such
 * thread's run has reached a terminal status. Repo-backed tasks advance here
 * too: the PR-open hook moves them earlier (mid-run, real-time) when it fires,
 * but thread-finish is the backstop so a task doesn't sit in In Progress forever
 * when PR detection misses (shell alias, script wrapper, or a PR opened by any
 * other means). RANK keeps this from moving a card backward, and a re-prompt
 * reopens it. Pure — unit-tested.
 *
 * Message-less threads are ignored entirely. Clicking "New chat" persists the
 * thread row before anything is typed, and `ThreadStorage.create` defaults
 * `status` to "completed" — so an empty chat someone opened next to a card is
 * born terminal and indistinguishable *by status* from a finished run. Counting
 * one would advance a card whose work nobody ever started; a card whose only
 * thread is empty has effectively no thread at all.
 */
export function shouldAdvanceToReview(item: {
  status: TaskBoardItemStatus;
  threads: { status: string | null; hasMessages: boolean }[];
}): boolean {
  if (item.status !== "in_progress") return false;
  const used = item.threads.filter((t) => t.hasMessages);
  if (used.length === 0) return false;
  return used.every(
    (t) => t.status !== null && TERMINAL_THREAD_STATUSES.has(t.status),
  );
}

/** True when the thread has a repo bound (`metadata.githubRepo.url`) — mirrors
 *  the web `agentHasClonableSource`, inlined to avoid importing web code. */
function threadHasClonableRepo(metadata: unknown): boolean {
  const meta =
    typeof metadata === "string"
      ? (() => {
          try {
            return JSON.parse(metadata) as unknown;
          } catch {
            return null;
          }
        })()
      : metadata;
  if (!meta || typeof meta !== "object") return false;
  const url = (meta as { githubRepo?: { url?: unknown } | null }).githubRepo
    ?.url;
  return typeof url === "string" && url.length > 0;
}

export class TaskBoardStorage {
  constructor(private db: Kysely<Database>) {}

  /**
   * Run `fn` in a transaction, reusing an enclosing one when this storage was
   * built over a `Transaction` — the import route does exactly that
   * (`new TaskBoardStorage(trx)`), and Kysely throws on a nested
   * `.transaction()`. An enclosing transaction already provides the atomicity
   * and single snapshot every caller here wants.
   */
  private inTransaction<T>(
    fn: (db: Kysely<Database>) => Promise<T>,
  ): Promise<T> {
    return this.db.isTransaction
      ? fn(this.db)
      : this.db.transaction().execute(fn);
  }

  async list(organizationId: string): Promise<TaskBoardItem[]> {
    const rows = await this.db
      .selectFrom("task_board_items")
      .selectAll()
      .where("organization_id", "=", organizationId)
      // Dismissed findings are off the board; `getById` still resolves them.
      .where("dismissed_at", "is", null)
      .orderBy("sort_order", "asc")
      .execute();

    const items = rows.map((row) => this.itemFromDbRow(row));
    await this.attachRefs(items, organizationId);
    return items;
  }

  async getById(
    id: string,
    organizationId: string,
  ): Promise<TaskBoardItem | null> {
    const row = await this.db
      .selectFrom("task_board_items")
      .selectAll()
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();

    if (!row) return null;
    const item = this.itemFromDbRow(row);
    await this.attachRefs([item], organizationId);
    return item;
  }

  async create(params: {
    organizationId: string;
    title: string;
    description?: string | null;
    status?: TaskBoardItemStatus;
    priority?: TaskBoardItemPriority;
    assigneeId?: string | null;
    assignedBy?: string | null;
    dueDate?: string | null;
    /** Sender-minted finding identity — see task-board-import. */
    externalKey?: string | null;
    by: string;
  }): Promise<TaskBoardItem> {
    const id = generatePrefixedId("board");
    const now = new Date().toISOString();
    const status = params.status ?? "triage";

    // New cards land at the top of their lane — one below the current lowest
    // sort_order (ascending order), matching the prior created_at-desc feel.
    // Computed as a subquery inside the INSERT itself (rather than a separate
    // SELECT beforehand plus an app-side -1) so two concurrent creates in the
    // same lane race for, at most, a single round trip instead of two — the
    // previous SELECT-then-INSERT left a full network round trip open for
    // another create to land on the same sort_order.
    const row = await this.db
      .insertInto("task_board_items")
      .values({
        id,
        organization_id: params.organizationId,
        title: params.title,
        description: params.description ?? null,
        status,
        priority: params.priority ?? "medium",
        assignee_id: params.assigneeId ?? null,
        assigned_by: params.assignedBy ?? null,
        due_date: params.dueDate ?? null,
        external_key: params.externalKey ?? null,
        sort_order: sql<number>`(
          select coalesce(min(sort_order), 0) - 1
          from task_board_items
          where organization_id = ${params.organizationId}
          and status = ${status}
        )`,
        created_by: params.by,
        created_at: now,
        updated_by: params.by,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Freshly created — no linked threads yet.
    return this.itemFromDbRow(row);
  }

  async update(
    id: string,
    organizationId: string,
    data: {
      title?: string;
      description?: string | null;
      status?: TaskBoardItemStatus;
      priority?: TaskBoardItemPriority;
      assigneeId?: string | null;
      assignedBy?: string | null;
      dueDate?: string | null;
      sortOrder?: number;
    },
    by: string,
  ): Promise<TaskBoardItem> {
    const row = await this.db
      .updateTable("task_board_items")
      .set({
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.description !== undefined
          ? { description: data.description }
          : {}),
        ...(data.status !== undefined ? { status: data.status } : {}),
        ...(data.priority !== undefined ? { priority: data.priority } : {}),
        ...(data.assigneeId !== undefined
          ? { assignee_id: data.assigneeId }
          : {}),
        ...(data.assignedBy !== undefined
          ? { assigned_by: data.assignedBy }
          : {}),
        ...(data.dueDate !== undefined ? { due_date: data.dueDate } : {}),
        ...(data.sortOrder !== undefined ? { sort_order: data.sortOrder } : {}),
        updated_by: by,
        updated_at: new Date().toISOString(),
      })
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .returningAll()
      .executeTakeFirstOrThrow();

    const item = this.itemFromDbRow(row);
    await this.attachRefs([item], organizationId);
    return item;
  }

  /**
   * Remove a task board item and its join rows.
   *
   * A reports-pushed card is DISMISSED rather than deleted: the row stays with
   * `dismissed_at` set, off the board, and the next diagnostic import skips its
   * `external_key` instead of re-creating the card. A hard delete would
   * silently undo itself on the next scan — the import matches only OPEN items
   * by key, and a deleted row matches nothing. Keeping the row also keeps the
   * card's comments, activity, threads and quota claim, so a restore brings
   * back the same card, and deleting one can't refund a charged slot via
   * `task_quota_claims`' ON DELETE CASCADE.
   *
   * The predicate is `isReportsTask`, NOT "has an external_key" — the quota
   * gate charges on `created_by = "system"`, and an imported item may omit its
   * key. Keying dismissal on the key would leave keyless system cards
   * hard-deletable, and therefore refundable.
   *
   * User-created cards are deleted outright.
   */
  /** Returns false when the id isn't in this org — a no-op, not a delete. */
  async delete(
    id: string,
    organizationId: string,
    by: string,
  ): Promise<boolean> {
    return this.inTransaction(async (trx) => {
      const row = await trx
        .selectFrom("task_board_items")
        .select(["created_by"])
        .where("id", "=", id)
        .where("organization_id", "=", organizationId)
        .executeTakeFirst();
      if (!row) return false;
      if (isReportsTask({ createdBy: row.created_by })) {
        await trx
          .updateTable("task_board_items")
          .set({ dismissed_at: new Date().toISOString(), updated_by: by })
          .where("id", "=", id)
          .where("organization_id", "=", organizationId)
          // Already dismissed — keep the first dismissal's who/when.
          .where("dismissed_at", "is", null)
          .execute();
        return true;
      }
      await trx
        .deleteFrom("task_board_item_threads")
        .where("task_board_item_id", "=", id)
        .where("organization_id", "=", organizationId)
        .execute();
      await trx
        .deleteFrom("task_board_item_prs")
        .where("task_board_item_id", "=", id)
        .where("organization_id", "=", organizationId)
        .execute();
      // task_board_item_tags cascades from task_board_items.
      await trx
        .deleteFrom("task_board_items")
        .where("id", "=", id)
        .where("organization_id", "=", organizationId)
        .execute();
      return true;
    });
  }

  /**
   * The finding keys the import must skip. Narrowed to the batch's own keys by
   * the caller — an org that has dismissed thousands of findings shouldn't
   * ship them all over the wire on every import.
   */
  async dismissedFindingKeys(
    organizationId: string,
    externalKeys: string[],
  ): Promise<Set<string>> {
    if (externalKeys.length === 0) return new Set();
    const rows = await this.db
      .selectFrom("task_board_items")
      .select(["external_key"])
      .where("organization_id", "=", organizationId)
      .where("external_key", "in", externalKeys)
      .where("dismissed_at", "is not", null)
      .execute();
    return new Set(rows.flatMap((r) => r.external_key ?? []));
  }

  async listDismissedFindings(
    organizationId: string,
  ): Promise<DismissedFinding[]> {
    const rows = await this.db
      .selectFrom("task_board_items")
      .select(["external_key", "updated_by", "dismissed_at"])
      .where("organization_id", "=", organizationId)
      .where("dismissed_at", "is not", null)
      .orderBy("dismissed_at", "desc")
      .execute();
    return rows.flatMap((r) =>
      r.external_key && r.dismissed_at
        ? [
            {
              externalKey: r.external_key,
              dismissedBy: r.updated_by,
              dismissedAt:
                r.dismissed_at instanceof Date
                  ? r.dismissed_at.toISOString()
                  : r.dismissed_at,
            },
          ]
        : [],
    );
  }

  /**
   * Un-dismiss findings so their cards return to the board and the import
   * refreshes them again. `externalKeys` omitted restores every dismissal for
   * the org. Returns how many cards came back, so a caller can tell
   * "restored 3" from "nothing matched".
   */
  async restoreDismissedFindings(
    organizationId: string,
    externalKeys?: string[],
  ): Promise<number> {
    if (externalKeys && externalKeys.length === 0) return 0;
    let query = this.db
      .updateTable("task_board_items")
      .set({ dismissed_at: null })
      .where("organization_id", "=", organizationId)
      .where("dismissed_at", "is not", null);
    if (externalKeys) {
      query = query.where("external_key", "in", externalKeys);
    }
    const result = await query.executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0n);
  }

  /**
   * Set the tags attached to a task. Applies a diff rather than
   * replace-everything so an already-attached tag keeps its original
   * `created_by`/`created_at` — that's who tagged it and when. The task and all
   * `tagIds` must already be verified as belonging to the caller's org.
   */
  async setItemTags(
    taskBoardItemId: string,
    tagIds: string[],
    by: string,
  ): Promise<void> {
    await this.inTransaction(async (trx) => {
      await trx
        .deleteFrom("task_board_item_tags")
        .where("task_board_item_id", "=", taskBoardItemId)
        .$if(tagIds.length > 0, (qb) => qb.where("id", "not in", tagIds))
        .execute();

      if (tagIds.length > 0) {
        await trx
          .insertInto("task_board_item_tags")
          .values(
            tagIds.map((id) => ({
              task_board_item_id: taskBoardItemId,
              id,
              created_by: by,
              created_at: new Date().toISOString(),
            })),
          )
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
    });
  }

  /**
   * Link an agent thread to a task (many-to-many). Idempotent — re-linking the
   * same pair is a no-op, so a run replay can't duplicate the row.
   */
  async linkThread(
    taskBoardItemId: string,
    threadId: string,
    organizationId: string,
  ): Promise<void> {
    await this.db
      .insertInto("task_board_item_threads")
      .values({
        task_board_item_id: taskBoardItemId,
        thread_id: threadId,
        organization_id: organizationId,
      })
      .onConflict((oc) =>
        oc.columns(["task_board_item_id", "thread_id"]).doNothing(),
      )
      .execute();
  }

  /**
   * Task ids linked to a run thread (reverse of the many-to-many link). Public
   * so a run-metadata-less caller (a PR opened on a re-prompted thread) can
   * resolve its task the same way the thread-finish/reopen hooks do.
   */
  /**
   * Super Agent tasks parked In Review, oldest-touched first — the review
   * sweeper's work list (see `review-sweeper.ts`).
   *
   * Cross-org by design: the sweeper is a process-level reconciler with no
   * request org, and each item carries its own so the caller can build the
   * right context. Oldest first so a long backlog drains fairly instead of the
   * newest cards starving the ones that have been stuck longest, and bounded by
   * `limit` so one tick can't scan an unbounded board.
   */
  async listItemsPendingReview(
    limit: number,
  ): Promise<{ id: string; organizationId: string }[]> {
    const rows = await this.db
      .selectFrom("task_board_items")
      .select(["id", "organization_id as organizationId"])
      .where("status", "=", "in_review")
      .where("assignee_id", "=", SUPER_AGENT_ASSIGNEE_ID)
      .where("dismissed_at", "is", null)
      .orderBy("updated_at", "asc")
      .limit(limit)
      .execute();
    return rows;
  }

  async linkedTaskIds(
    threadId: string,
    organizationId: string,
  ): Promise<string[]> {
    const rows = await this.db
      .selectFrom("task_board_item_threads")
      .select("task_board_item_id as taskId")
      .where("thread_id", "=", threadId)
      .where("organization_id", "=", organizationId)
      .execute();
    return rows.map((r) => r.taskId);
  }

  /**
   * Link a GitHub PR to a task (idempotent per (task, url) — a run replay or a
   * repeated PR tool call can't duplicate the row). `prNumber`/`repoOwner`/
   * `repoName` are derived from the PR url at capture time.
   */
  async linkPr(params: {
    taskBoardItemId: string;
    organizationId: string;
    url: string;
    prNumber: number;
    repoOwner: string;
    repoName: string;
    connectionId?: string | null;
  }): Promise<void> {
    await this.db
      .insertInto("task_board_item_prs")
      .values({
        task_board_item_id: params.taskBoardItemId,
        organization_id: params.organizationId,
        url: params.url,
        pr_number: params.prNumber,
        repo_owner: params.repoOwner,
        repo_name: params.repoName,
        connection_id: params.connectionId ?? null,
      })
      .onConflict((oc) => oc.columns(["task_board_item_id", "url"]).doNothing())
      .execute();
  }

  /** PRs linked to a task (most-recent first), identity only. */
  async listPrs(
    taskBoardItemId: string,
    organizationId: string,
  ): Promise<TaskBoardItemPrRef[]> {
    const rows = await this.db
      .selectFrom("task_board_item_prs")
      .select([
        "url",
        "pr_number as prNumber",
        "repo_owner as repoOwner",
        "repo_name as repoName",
        "connection_id as connectionId",
        "created_at as createdAt",
      ])
      .where("task_board_item_id", "=", taskBoardItemId)
      .where("organization_id", "=", organizationId)
      .orderBy("created_at", "desc")
      .execute();
    return rows.map((r) => ({
      url: r.url,
      number: r.prNumber,
      repoOwner: r.repoOwner,
      repoName: r.repoName,
      connectionId: r.connectionId ?? null,
      createdAt:
        r.createdAt instanceof Date
          ? r.createdAt.toISOString()
          : (r.createdAt as unknown as string),
    }));
  }

  /**
   * A linked thread reached a terminal run status — advance any of its tasks
   * that qualify (see `shouldAdvanceToReview`) to In Review. Returns the items
   * that actually moved so the caller can broadcast them over SSE.
   */
  async advanceLinkedTasksToReviewOnThreadFinish(
    threadId: string,
    organizationId: string,
  ): Promise<TaskBoardItem[]> {
    const moved: TaskBoardItem[] = [];
    for (const taskId of await this.linkedTaskIds(threadId, organizationId)) {
      const item = await this.getById(taskId, organizationId);
      if (!item || !shouldAdvanceToReview(item)) continue;
      // The status flip is a CONDITIONAL update guarded on the status we just
      // read, so exactly one concurrent caller can win it.
      //
      // It used to be an unconditional `update()`, and the read-then-write above
      // is not atomic: `recoverStalledTasks` runs fire-and-forget on EVERY
      // `TASK_BOARD_ITEM_LIST` over the list that read already loaded, so N
      // overlapping board reads (multiple tabs, a refocus burst, the Super
      // Agent calling the tool itself) each saw `in_progress` and each wrote.
      // One prod item collected 42 of these; another took 27 inside 112 ms.
      //
      // The duplicate ROW was not the real damage — the duplicate ACTIVITY was.
      // `reviewCycleStart` reads the newest `status_changed→in_review` as the
      // start of the current review cycle, so every redundant stamp invalidated
      // every approval recorded before it: the verified-approval gate stopped
      // seeing a complete set, auto-merge never fired, and the card sat In
      // Review forever. In prod all 13 items holding an approval had been
      // stranded this way, one of them 15 seconds after approving.
      const advanced = await this.advanceToReviewIfInProgress(
        taskId,
        organizationId,
        item.updatedBy,
      );
      if (!advanced) continue;
      moved.push(advanced);
      // Record the transition — the reviewer flow keys its "current review
      // cycle" off the newest `status_changed→in_review` activity, and a
      // re-review (Super Agent pushed a fix to the same PR, no new PR opened)
      // re-enters In Review only through THIS path. Without the activity row
      // the cycle boundary would stay stale and reviewers would never re-run.
      // Machine-driven, hence a null actor. Best-effort. Reached only by the
      // caller that won the flip above, so it writes exactly once per cycle.
      await this.recordActivity({
        taskBoardItemId: taskId,
        action: "status_changed",
        actorId: null,
        data: { from: item.status, to: "in_review" },
      }).catch((err) =>
        console.error("[task-board] in_review activity write failed", err),
      );
    }
    return moved;
  }

  /**
   * Flip a task to In Review only if it is still `in_progress`, returning the
   * updated item or null when another caller already moved it.
   *
   * The `where status = 'in_progress'` predicate is the whole point: it makes
   * the advance idempotent under concurrency, which the plain `update()` is not.
   * See the caller above for what the duplicates cost.
   */
  async advanceToReviewIfInProgress(
    id: string,
    organizationId: string,
    by: string,
  ): Promise<TaskBoardItem | null> {
    const row = await this.db
      .updateTable("task_board_items")
      .set({
        status: "in_review",
        updated_by: by,
        updated_at: new Date().toISOString(),
      })
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .where("status", "=", "in_progress")
      .returningAll()
      .executeTakeFirst();

    if (!row) return null;
    const item = this.itemFromDbRow(row);
    await this.attachRefs([item], organizationId);
    return item;
  }

  /**
   * A new run is starting on a thread — pull any linked task sitting in In
   * Review back to In Progress (the user re-engaged it). Returns moved items.
   */
  async reopenLinkedTasksOnThreadRun(
    threadId: string,
    organizationId: string,
  ): Promise<TaskBoardItem[]> {
    const moved: TaskBoardItem[] = [];
    for (const taskId of await this.linkedTaskIds(threadId, organizationId)) {
      const item = await this.getById(taskId, organizationId);
      if (!item || item.status !== "in_review") continue;
      moved.push(
        await this.update(
          taskId,
          organizationId,
          { status: "in_progress" },
          item.updatedBy,
        ),
      );
    }
    return moved;
  }

  /**
   * Atomically claim a task for merge-conflict auto-resolution: move it from In
   * Review to In Progress ONLY if it's still In Review AND still assigned to
   * the Super Agent, returning the updated item to the single winner and null
   * to everyone else. The auto-resolve reaction fires from two triggers that
   * can coincide — a reviewer's approval (`review-decision`) and the PR
   * modal's poll (`prs-get`) — so, like `claimReviewer`, this fence must be
   * atomic: a read-then-write would let both dispatch a Super Agent run on the
   * same PR. The assignee re-check closes a second race: the caller's
   * assignee check runs against a read taken before this write, so a human
   * reassigning the task away from the Super Agent in between must still stop
   * the claim — checking it only in the WHERE, not after, means neither
   * caller can slip a stale-assignee claim through. A single conditional
   * UPDATE is atomic under READ COMMITTED — the second writer re-checks
   * `status`/`assignee_id` against the first's committed row and matches
   * nothing.
   */
  claimConflictResolution(
    id: string,
    organizationId: string,
    by: string,
  ): Promise<TaskBoardItem | null> {
    return this.claimInReviewSuperAgentSlot(id, organizationId, by);
  }

  /**
   * Atomically claim a task for a reviewer's `request_changes` bounce: move it
   * from In Review to In Progress ONLY if it's still In Review AND still
   * assigned to the Super Agent, returning the updated item to the single
   * winner and null to everyone else. QA and Code Reviewer run concurrently,
   * and either can independently decide changes are needed — without this
   * fence both would bounce the task and each enqueue its own Super Agent run
   * on the SAME PR, racing to push conflicting commits. The assignee re-check
   * closes a second race: a human can reassign the task away from the Super
   * Agent while a reviewer run is still in flight, and that reviewer's later
   * `request_changes` must not yank the task back and re-enqueue the Super
   * Agent out from under the new owner. Same atomic-conditional-UPDATE pattern
   * as `claimConflictResolution`.
   */
  claimReviewChangesBounce(
    id: string,
    organizationId: string,
    by: string,
  ): Promise<TaskBoardItem | null> {
    return this.claimInReviewSuperAgentSlot(id, organizationId, by);
  }

  /**
   * Shared fence behind both claim methods above: move a task from In Review
   * to In Progress ONLY if it's still In Review AND still assigned to the
   * Super Agent, returning the updated item to the single winner and null to
   * everyone else. A single conditional UPDATE is atomic under READ
   * COMMITTED — a second, concurrent caller re-checks `status`/`assignee_id`
   * against the first's committed row and matches nothing.
   */
  private async claimInReviewSuperAgentSlot(
    id: string,
    organizationId: string,
    by: string,
  ): Promise<TaskBoardItem | null> {
    const row = await this.db
      .updateTable("task_board_items")
      .set({
        status: "in_progress",
        updated_by: by,
        updated_at: new Date().toISOString(),
      })
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .where("status", "=", "in_review")
      .where("assignee_id", "=", SUPER_AGENT_ASSIGNEE_ID)
      .returningAll()
      .executeTakeFirst();
    if (!row) return null;
    const item = this.itemFromDbRow(row);
    await this.attachRefs([item], organizationId);
    return item;
  }

  /**
   * Populate each item's `threads` and `tags` — one transaction, so a card
   * can't read its threads from before a concurrent edit and its tags from
   * after.
   */
  private async attachRefs(
    items: TaskBoardItem[],
    organizationId: string,
  ): Promise<void> {
    if (items.length === 0) return;
    await this.inTransaction(async (db) => {
      await this.attachThreads(db, items, organizationId);
      await this.attachTags(db, items);
    });
  }

  /**
   * Populate each item's `threads` (most-recent first) with the linked thread's
   * live run status/title. One batched query for the whole set.
   */
  private async attachThreads(
    db: Kysely<Database>,
    items: TaskBoardItem[],
    organizationId: string,
  ): Promise<void> {
    const ids = items.map((i) => i.id);

    const rows = await db
      .selectFrom("task_board_item_threads as link")
      .innerJoin("threads as t", "t.id", "link.thread_id")
      // Latest assistant text part (v2 stream-of-record) for the card preview.
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom("thread_message_parts as p")
            .select("p.payload as payload")
            .whereRef("p.thread_id", "=", "link.thread_id")
            .where("p.role", "=", "assistant")
            .where("p.kind", "=", "text")
            .orderBy("p.created_at", "desc")
            .limit(1)
            .as("lastmsg"),
        (join) => join.onTrue(),
      )
      .select((eb) => [
        "link.task_board_item_id as taskId",
        "link.thread_id as threadId",
        "link.created_at as createdAt",
        "t.status as status",
        "t.title as title",
        "t.virtual_mcp_id as virtualMcpId",
        "t.metadata as metadata",
        "lastmsg.payload as lastMessagePayload",
        // Was this thread ever used? Both storage formats, any role — v2 writes
        // parts, deprecated v1 threads still have `thread_messages` rows, and a
        // run that emitted only tool calls has no assistant *text* so
        // `lastMessage` can't stand in for this.
        eb
          .or([
            eb.exists(
              eb
                .selectFrom("thread_message_parts as mp")
                .select("mp.id")
                .whereRef("mp.thread_id", "=", "link.thread_id"),
            ),
            eb.exists(
              eb
                .selectFrom("thread_messages as tm")
                .select("tm.id")
                .whereRef("tm.thread_id", "=", "link.thread_id"),
            ),
          ])
          .as("hasMessages"),
      ])
      .where("link.organization_id", "=", organizationId)
      .where("link.task_board_item_id", "in", ids)
      .orderBy("link.created_at", "desc")
      .execute();

    const byItem = new Map<string, TaskBoardItemThreadRef[]>();
    for (const row of rows) {
      const ref: TaskBoardItemThreadRef = {
        threadId: row.threadId,
        virtualMcpId: row.virtualMcpId ?? null,
        status: row.status ?? null,
        title: row.title ?? null,
        lastMessage: extractPartText(row.lastMessagePayload),
        hasPreview: threadHasClonableRepo(row.metadata),
        hasMessages: !!row.hasMessages,
        createdAt:
          row.createdAt instanceof Date
            ? row.createdAt.toISOString()
            : (row.createdAt as unknown as string),
      };
      const list = byItem.get(row.taskId);
      if (list) list.push(ref);
      else byItem.set(row.taskId, [ref]);
    }

    for (const item of items) item.threads = byItem.get(item.id) ?? [];
  }

  /** Populate each item's `tags`, name ascending. One batched query. Items are
   *  already org-scoped by the caller, so the join needs no org filter. */
  private async attachTags(
    db: Kysely<Database>,
    items: TaskBoardItem[],
  ): Promise<void> {
    const ids = items.map((i) => i.id);

    const rows = await db
      .selectFrom("task_board_item_tags as link")
      .innerJoin("organization_tags as tag", "tag.id", "link.id")
      .select([
        "link.task_board_item_id as taskId",
        "link.created_by as createdBy",
        "link.created_at as createdAt",
        "tag.id as id",
        "tag.name as name",
        "tag.color as color",
      ])
      .where("link.task_board_item_id", "in", ids)
      .orderBy("tag.name", "asc")
      .execute();

    const byItem = new Map<string, TaskBoardItemTagRef[]>();
    for (const row of rows) {
      const ref: TaskBoardItemTagRef = {
        id: row.id,
        name: row.name,
        color: row.color ?? null,
        createdBy: row.createdBy,
        createdAt:
          row.createdAt instanceof Date
            ? row.createdAt.toISOString()
            : (row.createdAt as unknown as string),
      };
      const list = byItem.get(row.taskId);
      if (list) list.push(ref);
      else byItem.set(row.taskId, [ref]);
    }

    for (const item of items) item.tags = byItem.get(item.id) ?? [];
  }

  // --------------------------------------------------------------------------
  // Activity log (the card's change timeline)
  // --------------------------------------------------------------------------

  /** Append one activity event. Best-effort at the call site — never let a log
   *  write fail the change it describes. A null `actorId` means the
   *  agent/system did it, not a member. */
  async recordActivity(params: {
    taskBoardItemId: string;
    action: TaskBoardActivityAction;
    actorId: string | null;
    data?: Record<string, unknown>;
  }): Promise<void> {
    await this.db
      .insertInto("task_board_activity")
      .values({
        id: generatePrefixedId("act"),
        task_board_item_id: params.taskBoardItemId,
        action: params.action,
        actor_id: params.actorId,
        data: params.data ? JSON.stringify(params.data) : null,
        occurred_at: new Date().toISOString(),
      })
      .execute();
  }

  /**
   * Atomically claim the (task, reviewer, cycle) slot, minting a token.
   * `claimed` is false when the slot was already taken (a concurrent enqueue
   * won the race) — the caller then skips enqueueing that reviewer. Either way
   * returns the winning claim's `token`, which the reviewer run carries and
   * echoes back to prove its identity when it records a decision.
   */
  async claimReviewer(
    taskBoardItemId: string,
    reviewer: string,
    cycleAt: Date,
  ): Promise<{ claimed: boolean; token: string }> {
    const token = `rtok_${crypto.randomUUID()}`;
    const inserted = await this.db
      .insertInto("task_board_review_claims")
      .values({
        task_board_item_id: taskBoardItemId,
        reviewer,
        cycle_at: cycleAt,
        token,
      })
      .onConflict((oc) =>
        oc.columns(["task_board_item_id", "reviewer", "cycle_at"]).doNothing(),
      )
      .returning("token")
      .executeTakeFirst();
    if (inserted) return { claimed: true, token: inserted.token };
    const existing = await this.db
      .selectFrom("task_board_review_claims")
      .select("token")
      .where("task_board_item_id", "=", taskBoardItemId)
      .where("reviewer", "=", reviewer)
      .where("cycle_at", "=", cycleAt)
      .executeTakeFirst();
    return { claimed: false, token: existing?.token ?? token };
  }

  /**
   * Release a reviewer's claim on a cycle — the counterpart to `claimReviewer`
   * for when the dispatch it was minted for never actually ran (e.g. the
   * enqueue itself threw). Without this, a transient dispatch failure leaves
   * the slot permanently claimed with no thread behind it: `claimReviewer`'s
   * unique (task, reviewer, cycle) key would refuse every retry for the rest
   * of that review cycle, so that reviewer would simply never run.
   */
  async releaseReviewerClaim(
    taskBoardItemId: string,
    reviewer: string,
    cycleAt: Date,
  ): Promise<void> {
    await this.db
      .deleteFrom("task_board_review_claims")
      .where("task_board_item_id", "=", taskBoardItemId)
      .where("reviewer", "=", reviewer)
      .where("cycle_at", "=", cycleAt)
      .execute();
  }

  /** Resolve a review token to its claim (which reviewer, which cycle) for a
   *  task. Null when the token doesn't belong to this task — used to verify
   *  that a decision's caller really is the reviewer it claims to be. */
  async resolveReviewClaimByToken(
    taskBoardItemId: string,
    token: string,
  ): Promise<{ reviewer: string; cycleAt: Date } | null> {
    const row = await this.db
      .selectFrom("task_board_review_claims")
      .select(["reviewer", "cycle_at"])
      .where("task_board_item_id", "=", taskBoardItemId)
      .where("token", "=", token)
      .executeTakeFirst();
    return row ? { reviewer: row.reviewer, cycleAt: row.cycle_at } : null;
  }

  /** Append several activity events in one insert — same semantics as
   *  `recordActivity`, batched so a caller earning multiple timeline entries
   *  from one change (e.g. a status+assignee+tags update) pays a single DB
   *  round-trip instead of one per entry. */
  async recordActivities(
    entries: {
      taskBoardItemId: string;
      action: TaskBoardActivityAction;
      actorId: string | null;
      data?: Record<string, unknown>;
    }[],
  ): Promise<void> {
    if (entries.length === 0) return;
    const now = new Date().toISOString();
    await this.db
      .insertInto("task_board_activity")
      .values(
        entries.map((params) => ({
          id: generatePrefixedId("act"),
          task_board_item_id: params.taskBoardItemId,
          action: params.action,
          actor_id: params.actorId,
          data: params.data ? JSON.stringify(params.data) : null,
          occurred_at: now,
        })),
      )
      .execute();
  }

  /** A task's activity, oldest first (timeline order). Tenant-scoped through
   *  the task, which is the only thing carrying an org. */
  async listActivity(
    taskBoardItemId: string,
    organizationId: string,
  ): Promise<TaskBoardActivity[]> {
    const rows = await this.db
      .selectFrom("task_board_activity as a")
      .innerJoin("task_board_items as item", "item.id", "a.task_board_item_id")
      .selectAll("a")
      .where("item.organization_id", "=", organizationId)
      .where("a.task_board_item_id", "=", taskBoardItemId)
      .orderBy("a.occurred_at", "asc")
      .execute();
    return rows.map((row) => ({
      id: row.id,
      taskBoardItemId: row.task_board_item_id,
      action: row.action,
      actorId: row.actor_id,
      data:
        typeof row.data === "string" ? JSON.parse(row.data) : (row.data ?? {}),
      occurredAt:
        row.occurred_at instanceof Date
          ? row.occurred_at.toISOString()
          : row.occurred_at,
    }));
  }

  /** A task's comments, oldest first (thread order). Tenant-scoped through the
   *  task, which is the only thing carrying an org. Flat — the caller nests
   *  roots and replies by `parentId`. */
  async listComments(
    taskBoardItemId: string,
    organizationId: string,
  ): Promise<TaskBoardComment[]> {
    const rows = await this.db
      .selectFrom("task_board_comments as c")
      .innerJoin("task_board_items as item", "item.id", "c.task_board_item_id")
      .selectAll("c")
      .where("item.organization_id", "=", organizationId)
      .where("c.task_board_item_id", "=", taskBoardItemId)
      .orderBy("c.created_at", "asc")
      .execute();
    return rows.map((row) => commentFromDbRow(row));
  }

  /** Post a comment (or a reply, when `parentId` is set). Returns null when the
   *  task isn't in this org, so a caller can't comment across tenants. */
  async createComment(params: {
    taskBoardItemId: string;
    organizationId: string;
    parentId?: string | null;
    authorId: string;
    body: string;
  }): Promise<TaskBoardComment | null> {
    const task = await this.db
      .selectFrom("task_board_items")
      .select("id")
      .where("id", "=", params.taskBoardItemId)
      .where("organization_id", "=", params.organizationId)
      .executeTakeFirst();
    if (!task) return null;

    // A reply hangs off a root of the same task; replying to a reply would give
    // the UI a depth it can't render, so flatten it onto the root.
    let parentId: string | null = null;
    if (params.parentId) {
      const parent = await this.db
        .selectFrom("task_board_comments")
        .select(["id", "parent_id"])
        .where("id", "=", params.parentId)
        .where("task_board_item_id", "=", params.taskBoardItemId)
        .executeTakeFirst();
      if (!parent) return null;
      parentId = parent.parent_id ?? parent.id;
    }

    const row = await this.db
      .insertInto("task_board_comments")
      .values({
        id: generatePrefixedId("cmt"),
        task_board_item_id: params.taskBoardItemId,
        parent_id: parentId,
        author_id: params.authorId,
        body: params.body,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return commentFromDbRow(row);
  }

  /** Edit a comment's body and/or a thread's resolved flag. Null when the
   *  comment isn't in this org, or a body edit is attempted by someone other
   *  than its author — resolving a thread is a shared, not an authored,
   *  action, so that one is open to anyone with access to the task. */
  async updateComment(params: {
    id: string;
    organizationId: string;
    callerId: string;
    body?: string;
    resolved?: boolean;
  }): Promise<TaskBoardComment | null> {
    const existing = await this.commentInOrg(params.id, params.organizationId);
    if (!existing) return null;
    if (params.body !== undefined && existing.authorId !== params.callerId) {
      return null;
    }
    // resolved is a thread property (see migration 159) — only a root carries
    // it, so resolving a reply would silently no-op the intent.
    if (params.resolved !== undefined && existing.parentId !== null) {
      return null;
    }

    const row = await this.db
      .updateTable("task_board_comments")
      .set({
        ...(params.body === undefined ? {} : { body: params.body }),
        ...(params.resolved === undefined ? {} : { resolved: params.resolved }),
        updated_at: new Date().toISOString(),
      })
      .where("id", "=", params.id)
      .returningAll()
      .executeTakeFirst();
    return row ? commentFromDbRow(row) : null;
  }

  /** Delete a comment; a root takes its replies with it (FK cascade). False
   *  when the comment isn't in this org, or isn't the caller's own — except a
   *  Super Agent comment, which nobody's `authorId` ever matches, so any org
   *  member (already access-checked) may remove it; it's working for the org,
   *  not a person whose comment they shouldn't be able to erase. */
  async deleteComment(
    id: string,
    organizationId: string,
    callerId: string,
  ): Promise<boolean> {
    const existing = await this.commentInOrg(id, organizationId);
    if (!existing) return false;
    if (
      existing.authorId !== callerId &&
      existing.authorId !== SUPER_AGENT_ASSIGNEE_ID
    ) {
      return false;
    }
    await this.db
      .deleteFrom("task_board_comments")
      .where("id", "=", id)
      .execute();
    return true;
  }

  private async commentInOrg(
    id: string,
    organizationId: string,
  ): Promise<{ authorId: string; parentId: string | null } | null> {
    const row = await this.db
      .selectFrom("task_board_comments as c")
      .innerJoin("task_board_items as item", "item.id", "c.task_board_item_id")
      .select(["c.id", "c.author_id", "c.parent_id"])
      .where("c.id", "=", id)
      .where("item.organization_id", "=", organizationId)
      .executeTakeFirst();
    return row ? { authorId: row.author_id, parentId: row.parent_id } : null;
  }

  private itemFromDbRow(row: {
    id: string;
    organization_id: string;
    title: string;
    description: string | null;
    status: string;
    priority: string;
    assignee_id: string | null;
    assigned_by: string | null;
    due_date: string | Date | null;
    sort_order: number;
    created_by: string;
    created_at: string | Date;
    updated_by: string;
    updated_at: string | Date;
  }): TaskBoardItem {
    return {
      id: row.id,
      organizationId: row.organization_id,
      title: row.title,
      description: row.description,
      status: row.status as TaskBoardItemStatus,
      priority: row.priority as TaskBoardItemPriority,
      assigneeId: row.assignee_id,
      assignedBy: row.assigned_by,
      dueDate:
        row.due_date instanceof Date
          ? row.due_date.toISOString()
          : row.due_date,
      sortOrder: row.sort_order,
      // Populated by attachThreads/attachTags for reads; empty for a fresh create.
      threads: [],
      tags: [],
      createdBy: row.created_by,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : row.created_at,
      updatedBy: row.updated_by,
      updatedAt:
        row.updated_at instanceof Date
          ? row.updated_at.toISOString()
          : row.updated_at,
    };
  }
}
