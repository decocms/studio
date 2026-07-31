/**
 * Task Board Storage Implementation
 *
 * Handles CRUD operations for org-scoped task board items, plus the
 * many-to-many link between a task and the agent threads run for it.
 */

import { sql, type Kysely } from "kysely";
import type {
  Database,
  TaskBoardActivity,
  TaskBoardActivityAction,
  TaskBoardComment,
  TaskBoardCommentMention,
  TaskBoardItem,
  TaskBoardItemPriority,
  TaskBoardItemPrRef,
  TaskBoardItemStatus,
  TaskBoardItemTagRef,
  TaskBoardItemThreadRef,
} from "./types";
import { generatePrefixedId } from "@decocms/shared/utils/generate-id";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";

/** What `postAgentReplyForThread` found: the comment thread a Super Agent run
 *  belongs to, and the reply it posted (null when the run answered nothing, or
 *  the reply was already there). */
export interface AgentReplyOutcome {
  taskBoardItemId: string;
  threadRootId: string;
  comment: TaskBoardComment | null;
}

/** A comment row as the wire sees it. `mentions` arrives parsed from jsonb on
 *  a read and as the string we wrote on an `INSERT ... RETURNING`. */
function commentFromDbRow(row: {
  id: string;
  task_board_item_id: string;
  parent_id: string | null;
  author_id: string | null;
  body: string;
  mentions: unknown;
  resolved: boolean;
  created_at: string | Date;
  updated_at: string | Date;
}): TaskBoardComment {
  const mentions =
    typeof row.mentions === "string" ? JSON.parse(row.mentions) : row.mentions;
  return {
    id: row.id,
    taskBoardItemId: row.task_board_item_id,
    parentId: row.parent_id,
    authorId: row.author_id,
    body: row.body,
    mentions: Array.isArray(mentions) ? mentions : [],
    resolved: row.resolved,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : row.created_at,
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : row.updated_at,
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
const TERMINAL_THREAD_STATUSES = new Set(["completed", "failed", "expired"]);

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
    const { minOrder } = await this.db
      .selectFrom("task_board_items")
      .select((eb) => eb.fn.min("sort_order").as("minOrder"))
      .where("organization_id", "=", params.organizationId)
      .where("status", "=", status)
      .executeTakeFirstOrThrow();

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
        sort_order: (minOrder ?? 0) - 1,
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

  async delete(id: string, organizationId: string): Promise<void> {
    await this.inTransaction(async (trx) => {
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
    });
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
      moved.push(
        await this.update(
          taskId,
          organizationId,
          { status: "in_review" },
          item.updatedBy,
        ),
      );
      // Record the transition — the reviewer flow keys its "current review
      // cycle" off the newest `status_changed→in_review` activity, and a
      // re-review (Super Agent pushed a fix to the same PR, no new PR opened)
      // re-enters In Review only through THIS path. Without the activity row
      // the cycle boundary would stay stale and reviewers would never re-run.
      // Machine-driven, hence a null actor. Best-effort.
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

  // --------------------------------------------------------------------------
  // Comments (the discussion threads in the task dialog's activity feed)
  // --------------------------------------------------------------------------

  /** A task's comments, oldest first. Flat — the read tool nests replies under
   *  their root. Tenant-scoped through the task, the only side carrying an org. */
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

  async getComment(
    id: string,
    organizationId: string,
  ): Promise<TaskBoardComment | null> {
    const row = await this.db
      .selectFrom("task_board_comments as c")
      .innerJoin("task_board_items as item", "item.id", "c.task_board_item_id")
      .selectAll("c")
      .where("item.organization_id", "=", organizationId)
      .where("c.id", "=", id)
      .executeTakeFirst();
    return row ? commentFromDbRow(row) : null;
  }

  /**
   * Add a comment to a task. `parentId` must be a thread ROOT of the same task
   * — replying to a reply is rejected, which is what keeps threads one level
   * deep (a CHECK constraint can't see the grandparent). Throws when the task
   * or the parent doesn't resolve inside `organizationId`.
   */
  async createComment(params: {
    taskBoardItemId: string;
    organizationId: string;
    parentId?: string | null;
    /** Null = the Super Agent wrote it. */
    authorId: string | null;
    body: string;
    mentions?: TaskBoardCommentMention[];
  }): Promise<TaskBoardComment> {
    const item = await this.db
      .selectFrom("task_board_items")
      .select("id")
      .where("id", "=", params.taskBoardItemId)
      .where("organization_id", "=", params.organizationId)
      .executeTakeFirst();
    if (!item) throw new Error(`Task not found: ${params.taskBoardItemId}`);

    if (params.parentId) {
      const parent = await this.getComment(
        params.parentId,
        params.organizationId,
      );
      if (!parent || parent.taskBoardItemId !== params.taskBoardItemId) {
        throw new Error(`Parent comment not found: ${params.parentId}`);
      }
      if (parent.parentId) {
        throw new Error("Comments nest one level: reply to the thread instead");
      }
    }

    const row = await this.db
      .insertInto("task_board_comments")
      .values({
        id: generatePrefixedId("cmt"),
        task_board_item_id: params.taskBoardItemId,
        parent_id: params.parentId ?? null,
        author_id: params.authorId,
        body: params.body,
        mentions: JSON.stringify(params.mentions ?? []),
        agent_thread_id: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return commentFromDbRow(row);
  }

  /**
   * Edit a comment's body and/or settle its thread. `resolved` applies to
   * thread roots only — a reply has no resolved state of its own. Returns null
   * when the comment isn't in the org.
   */
  async updateComment(
    id: string,
    organizationId: string,
    patch: { body?: string; resolved?: boolean },
  ): Promise<TaskBoardComment | null> {
    const current = await this.getComment(id, organizationId);
    if (!current) return null;
    if (patch.resolved !== undefined && current.parentId) {
      throw new Error("Only a thread root can be resolved");
    }
    const row = await this.db
      .updateTable("task_board_comments")
      .set({
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.resolved !== undefined ? { resolved: patch.resolved } : {}),
        updated_at: new Date().toISOString(),
      })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return commentFromDbRow(row);
  }

  /** Delete a comment; its replies cascade. False when it isn't in the org. */
  async deleteComment(id: string, organizationId: string): Promise<boolean> {
    const current = await this.getComment(id, organizationId);
    if (!current) return false;
    await this.db
      .deleteFrom("task_board_comments")
      .where("id", "=", id)
      .execute();
    return true;
  }

  /** Remember which Super Agent run a comment's `@`-mention started, so the
   *  run's answer can find its way back as a reply. */
  async setCommentAgentThread(id: string, threadId: string): Promise<void> {
    await this.db
      .updateTable("task_board_comments")
      .set({ agent_thread_id: threadId })
      .where("id", "=", id)
      .execute();
  }

  /**
   * Human comments on a task written after `sinceIso` — the run's mid-flight
   * view of what people said while it worked. The agent's own replies are
   * excluded (they're already in its context) and so is every other agent's,
   * since `author_id IS NULL` is the agent signature.
   */
  async listCommentsSince(
    taskBoardItemId: string,
    organizationId: string,
    sinceIso: string,
  ): Promise<
    {
      id: string;
      threadRootId: string;
      authorName: string;
      body: string;
      mentions: TaskBoardCommentMention[];
      createdAt: string;
    }[]
  > {
    const rows = await this.db
      .selectFrom("task_board_comments as c")
      .innerJoin("task_board_items as item", "item.id", "c.task_board_item_id")
      .leftJoin("user as u", "u.id", "c.author_id")
      .select([
        "c.id as id",
        "c.parent_id as parentId",
        "c.body as body",
        "c.mentions as mentions",
        "c.created_at as createdAt",
        "u.name as authorName",
      ])
      .where("item.organization_id", "=", organizationId)
      .where("c.task_board_item_id", "=", taskBoardItemId)
      .where("c.author_id", "is not", null)
      .where(sql<boolean>`c.created_at > ${sinceIso}::timestamptz`)
      .orderBy("c.created_at", "asc")
      .execute();

    return rows.map((row) => {
      const mentions =
        typeof row.mentions === "string"
          ? JSON.parse(row.mentions)
          : row.mentions;
      return {
        id: row.id,
        threadRootId: row.parentId ?? row.id,
        authorName: row.authorName ?? "Someone",
        body: row.body,
        mentions: Array.isArray(mentions) ? mentions : [],
        createdAt:
          row.createdAt instanceof Date
            ? row.createdAt.toISOString()
            : (row.createdAt as unknown as string),
      };
    });
  }

  /**
   * Human comments on a task the agent hasn't answered yet: everything written
   * after its most recent reply (all of them, when it has never replied).
   *
   * A dispatched turn is prompted with this whole backlog, not just the comment
   * that triggered it. Otherwise a comment with no mention is invisible forever —
   * it starts no run of its own, and the mid-run feed only carries what arrives
   * *while* a run is live. That's how "also what day is today?" got skipped, and
   * why the agent then truthfully said it couldn't see it.
   */
  async unansweredCommentBacklog(
    taskBoardItemId: string,
    organizationId: string,
  ): Promise<
    {
      id: string;
      authorName: string;
      body: string;
      mentions: TaskBoardCommentMention[];
      createdAt: string;
    }[]
  > {
    const lastReply = await this.db
      .selectFrom("task_board_comments")
      .select("created_at")
      .where("task_board_item_id", "=", taskBoardItemId)
      .where("author_id", "is", null)
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();

    const since =
      lastReply?.created_at instanceof Date
        ? lastReply.created_at.toISOString()
        : ((lastReply?.created_at as string | undefined) ??
          new Date(0).toISOString());

    const rows = await this.listCommentsSince(
      taskBoardItemId,
      organizationId,
      since,
    );
    return rows.map(({ threadRootId: _root, ...rest }) => rest);
  }

  /**
   * Threads on a task where someone mentioned the Super Agent and it hasn't
   * answered *since* that mention. "Answered" is an agent-authored comment
   * (`author_id IS NULL`) in the same thread, newer than the mention — so a
   * second mention in a thread the agent already replied to counts as
   * unanswered again, which is what makes a back-and-forth work.
   *
   * This is also the run-end safety net's work list, and what makes that net
   * idempotent: once a reply lands, the mention stops being unanswered, so a
   * hook that fires twice posts once.
   */
  async unansweredMentionThreads(
    taskBoardItemId: string,
    organizationId: string,
  ): Promise<{ commentId: string; threadRootId: string }[]> {
    const rows = await this.db
      .selectFrom("task_board_comments as c")
      .innerJoin("task_board_items as item", "item.id", "c.task_board_item_id")
      .select(["c.id as id", "c.parent_id as parentId"])
      .where("item.organization_id", "=", organizationId)
      .where("c.task_board_item_id", "=", taskBoardItemId)
      .where(
        sql<boolean>`c.mentions @> ${JSON.stringify([
          { kind: "user", id: SUPER_AGENT_ASSIGNEE_ID },
        ])}::jsonb`,
      )
      // "No agent comment in this thread, newer than the mention."
      .where(
        sql<boolean>`not exists (
          select 1 from task_board_comments r
          where coalesce(r.parent_id, r.id) = coalesce(c.parent_id, c.id)
            and r.author_id is null
            and r.created_at > c.created_at
        )`,
      )
      .orderBy("c.created_at", "asc")
      .execute();

    return rows.map((row) => ({
      commentId: row.id,
      threadRootId: row.parentId ?? row.id,
    }));
  }

  /**
   * The agent thread carrying this task's comment conversation, if it has one.
   *
   * One thread per task, reused for every mention: each new comment becomes a
   * turn on it, so the agent keeps the history of what was already discussed and
   * the thread gate (one run per thread) serializes turns for us. Any status
   * qualifies — a completed thread is exactly what a follow-up turn continues,
   * and keying on "still running" is what silently swallowed mentions before.
   */
  async commentConversationThread(
    taskBoardItemId: string,
    organizationId: string,
  ): Promise<string | null> {
    const row = await this.db
      .selectFrom("task_board_comments as c")
      .innerJoin("threads as t", "t.id", "c.agent_thread_id")
      .select("t.id as threadId")
      .where("c.task_board_item_id", "=", taskBoardItemId)
      .where("t.organization_id", "=", organizationId)
      .orderBy("c.created_at", "desc")
      .executeTakeFirst();
    return row?.threadId ?? null;
  }

  /**
   * A Super Agent run started by a comment mention has ended — the safety net.
   * Posts `fallbackBody` (the run's last assistant message) once into every
   * thread on that task still carrying an unanswered mention, so an ignored
   * mention never goes unanswered. Threads the agent already answered with
   * `reply_comment` are skipped, and nothing is posted when it answered
   * everything.
   *
   * Returns null when this run wasn't started from a comment. `threadRootIds`
   * covers every thread the run is accountable for (the originating one plus
   * any it was asked about mid-run), so the caller can clear each thread's
   * "typing…" indicator even where it posted nothing.
   */
  async finishCommentRun(
    threadId: string,
    organizationId: string,
    opts?: { postFallback?: boolean },
  ): Promise<{
    taskBoardItemId: string;
    threadRootIds: string[];
    posted: TaskBoardComment[];
  } | null> {
    const origin = await this.db
      .selectFrom("task_board_comments as c")
      .innerJoin("task_board_items as item", "item.id", "c.task_board_item_id")
      .select(["c.id as id", "c.task_board_item_id as taskId", "c.parent_id"])
      .where("item.organization_id", "=", organizationId)
      .where("c.agent_thread_id", "=", threadId)
      .orderBy("c.created_at", "asc")
      .executeTakeFirst();
    if (!origin) return null;

    const taskBoardItemId = origin.taskId;
    const unanswered = await this.unansweredMentionThreads(
      taskBoardItemId,
      organizationId,
    );
    const threadRootIds = [
      ...new Set([
        origin.parent_id ?? origin.id,
        ...unanswered.map((m) => m.threadRootId),
      ]),
    ];

    // A run parked on `user_ask` is waiting for a person, not done answering —
    // clear the indicator but don't put words in its mouth.
    if (opts?.postFallback === false) {
      return { taskBoardItemId, threadRootIds, posted: [] };
    }

    const fallbackBody = await this.lastAssistantText(threadId);
    if (!fallbackBody) return { taskBoardItemId, threadRootIds, posted: [] };

    // One reply per still-unanswered thread, not per mention — two mentions in
    // the same thread earn one answer.
    const posted: TaskBoardComment[] = [];
    for (const rootId of new Set(unanswered.map((m) => m.threadRootId))) {
      const comment = await this.insertAgentReply({
        threadId,
        taskBoardItemId,
        threadRootId: rootId,
        body: fallbackBody,
      });
      if (comment) posted.push(comment);
    }
    return { taskBoardItemId, threadRootIds, posted };
  }

  /**
   * The `reply_comment` built-in: the Super Agent answers a comment on the task
   * it is working on, by id. Returns null when the comment isn't in the org or
   * belongs to a different task than the run — the tool binds `taskBoardItemId`
   * from the run, so a model-supplied id can't reach another task's thread.
   */
  async replyToCommentAsAgent(params: {
    threadId: string;
    organizationId: string;
    taskBoardItemId: string;
    commentId: string;
    body: string;
  }): Promise<AgentReplyOutcome | null> {
    const target = await this.getComment(
      params.commentId,
      params.organizationId,
    );
    if (!target || target.taskBoardItemId !== params.taskBoardItemId) {
      return null;
    }
    const threadRootId = target.parentId ?? target.id;
    const comment = await this.insertAgentReply({
      threadId: params.threadId,
      taskBoardItemId: target.taskBoardItemId,
      threadRootId,
      body: params.body,
    });
    return {
      taskBoardItemId: target.taskBoardItemId,
      threadRootId,
      comment,
    };
  }

  /** Latest assistant text part of a thread (v2 stream-of-record). */
  private async lastAssistantText(threadId: string): Promise<string | null> {
    const last = await this.db
      .selectFrom("thread_message_parts")
      .select("payload")
      .where("thread_id", "=", threadId)
      .where("role", "=", "assistant")
      .where("kind", "=", "text")
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    return extractPartText(last?.payload);
  }

  /** Write one Super Agent reply into a comment thread. */
  private async insertAgentReply(params: {
    threadId: string;
    taskBoardItemId: string;
    threadRootId: string;
    body: string;
  }): Promise<TaskBoardComment | null> {
    const row = await this.db
      .insertInto("task_board_comments")
      .values({
        id: generatePrefixedId("cmt"),
        task_board_item_id: params.taskBoardItemId,
        parent_id: params.threadRootId,
        author_id: null,
        body: params.body,
        mentions: "[]",
        agent_thread_id: params.threadId,
      })
      .returningAll()
      .executeTakeFirst();
    return row ? commentFromDbRow(row) : null;
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
