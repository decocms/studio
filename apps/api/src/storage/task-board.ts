/**
 * Task Board Storage Implementation
 *
 * Handles CRUD operations for org-scoped task board items, plus the
 * many-to-many link between a task and the agent threads run for it.
 */

import type { Kysely } from "kysely";
import type {
  Database,
  TaskBoardActivity,
  TaskBoardActivityKind,
  TaskBoardItem,
  TaskBoardItemPriority,
  TaskBoardItemPrRef,
  TaskBoardItemStatus,
  TaskBoardItemThreadRef,
} from "./types";
import { generatePrefixedId } from "@decocms/shared/utils/generate-id";

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

  async list(organizationId: string): Promise<TaskBoardItem[]> {
    const rows = await this.db
      .selectFrom("task_board_items")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .orderBy("sort_order", "asc")
      .execute();

    const items = rows.map((row) => this.itemFromDbRow(row));
    await this.attachThreads(items, organizationId);
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
    await this.attachThreads([item], organizationId);
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
    await this.attachThreads([item], organizationId);
    return item;
  }

  async delete(id: string, organizationId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
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
      await trx
        .deleteFrom("task_board_items")
        .where("id", "=", id)
        .where("organization_id", "=", organizationId)
        .execute();
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
   * Populate each item's `threads` (most-recent first) with the linked thread's
   * live run status/title. One batched query for the whole set.
   */
  private async attachThreads(
    items: TaskBoardItem[],
    organizationId: string,
  ): Promise<void> {
    if (items.length === 0) return;
    const ids = items.map((i) => i.id);

    const rows = await this.db
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

  // --------------------------------------------------------------------------
  // Activity log (the card's change timeline)
  // --------------------------------------------------------------------------

  /** Append one activity event. Best-effort at the call site — never let a log
   *  write fail the change it describes. */
  async recordActivity(params: {
    organizationId: string;
    taskBoardItemId: string;
    kind: TaskBoardActivityKind;
    actorId: string | null;
    data?: Record<string, unknown>;
  }): Promise<void> {
    await this.db
      .insertInto("task_board_activity")
      .values({
        id: generatePrefixedId("act"),
        organization_id: params.organizationId,
        task_board_item_id: params.taskBoardItemId,
        kind: params.kind,
        actor_id: params.actorId,
        data: params.data ? JSON.stringify(params.data) : null,
        created_at: new Date().toISOString(),
      })
      .execute();
  }

  /** A task's activity, oldest first (timeline order). */
  async listActivity(
    taskBoardItemId: string,
    organizationId: string,
  ): Promise<TaskBoardActivity[]> {
    const rows = await this.db
      .selectFrom("task_board_activity")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("task_board_item_id", "=", taskBoardItemId)
      .orderBy("created_at", "asc")
      .execute();
    return rows.map((row) => ({
      id: row.id,
      taskBoardItemId: row.task_board_item_id,
      kind: row.kind as TaskBoardActivityKind,
      actorId: row.actor_id,
      data:
        typeof row.data === "string" ? JSON.parse(row.data) : (row.data ?? {}),
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : row.created_at,
    }));
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
      // Populated by attachThreads for reads; empty for a fresh create.
      threads: [],
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
