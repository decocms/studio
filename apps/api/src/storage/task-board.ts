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
  TaskBoardAttachmentMeta,
  TaskBoardComment,
  TaskBoardItem,
  TaskBoardItemPriority,
  TaskBoardItemPrRef,
  TaskBoardItemStatus,
  TaskBoardItemThreadRef,
  TaskBoardRelease,
  TaskBoardSprint,
  TaskBoardSprintState,
} from "./types";
import { generatePrefixedId } from "@decocms/shared/utils/generate-id";

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

/** Jsonb string array — pg may hand back a parsed array or a JSON string. */
function parseTags(value: unknown): string[] {
  const raw = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === "string");
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
    columnId?: string | null;
    tags?: string[];
    sprintId?: string | null;
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

    // Per-org short key: max(seq)+1. Race window is negligible at this scale;
    // the org+seq index would surface a collision as an error rather than a
    // silent dup if it ever bit.
    const maxSeq = await this.db
      .selectFrom("task_board_items")
      .select((eb) => eb.fn.max("seq").as("maxSeq"))
      .where("organization_id", "=", params.organizationId)
      .executeTakeFirst();
    const seq = (maxSeq?.maxSeq ?? 0) + 1;

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
        seq,
        column_id: params.columnId ?? null,
        tags: JSON.stringify(params.tags ?? []),
        sprint_id: params.sprintId ?? null,
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
      columnId?: string | null;
      tags?: string[];
      sprintId?: string | null;
      releaseId?: string | null;
      automationColumnId?: string | null;
    },
    by: string,
  ): Promise<TaskBoardItem> {
    // A status change without an explicit column placement (a run-driven
    // advance, or a default-board move) clears column_id so the card lands in
    // that stage's first configured column instead of a stale custom one.
    const columnId =
      data.columnId !== undefined
        ? data.columnId
        : data.status !== undefined
          ? null
          : undefined;
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
        ...(columnId !== undefined ? { column_id: columnId } : {}),
        ...(data.tags !== undefined ? { tags: JSON.stringify(data.tags) } : {}),
        ...(data.sprintId !== undefined ? { sprint_id: data.sprintId } : {}),
        ...(data.releaseId !== undefined ? { release_id: data.releaseId } : {}),
        ...(data.automationColumnId !== undefined
          ? { automation_column_id: data.automationColumnId }
          : {}),
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
    external_key: string | null;
    seq: number | null;
    column_id: string | null;
    tags: unknown;
    sprint_id: string | null;
    release_id: string | null;
    automation_column_id: string | null;
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
      dueDate: toIsoOrNull(row.due_date),
      sortOrder: row.sort_order,
      externalKey: row.external_key,
      seq: row.seq,
      columnId: row.column_id,
      tags: parseTags(row.tags),
      sprintId: row.sprint_id,
      releaseId: row.release_id,
      automationColumnId: row.automation_column_id,
      // Populated by attachThreads for reads; empty for a fresh create.
      threads: [],
      createdBy: row.created_by,
      createdAt: toIso(row.created_at),
      updatedBy: row.updated_by,
      updatedAt: toIso(row.updated_at),
    };
  }

  // --------------------------------------------------------------------------
  // Comments
  // --------------------------------------------------------------------------

  async createComment(params: {
    organizationId: string;
    taskBoardItemId: string;
    parentId?: string | null;
    body: string;
    by: string;
  }): Promise<TaskBoardComment> {
    const now = new Date().toISOString();
    const row = await this.db
      .insertInto("task_board_comments")
      .values({
        id: generatePrefixedId("cmt"),
        organization_id: params.organizationId,
        task_board_item_id: params.taskBoardItemId,
        parent_id: params.parentId ?? null,
        body: params.body,
        created_by: params.by,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.commentFromDbRow(row);
  }

  /** Comments for a task, oldest first, each with its attachment metadata. */
  async listComments(
    taskBoardItemId: string,
    organizationId: string,
  ): Promise<TaskBoardComment[]> {
    const rows = await this.db
      .selectFrom("task_board_comments")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("task_board_item_id", "=", taskBoardItemId)
      .orderBy("created_at", "asc")
      .execute();
    const comments = rows.map((row) => this.commentFromDbRow(row));
    if (comments.length > 0) {
      const attachments = await this.listAttachments(
        taskBoardItemId,
        organizationId,
      );
      const byComment = new Map<string, TaskBoardAttachmentMeta[]>();
      for (const a of attachments) {
        if (!a.commentId) continue;
        const list = byComment.get(a.commentId);
        if (list) list.push(a);
        else byComment.set(a.commentId, [a]);
      }
      for (const c of comments) c.attachments = byComment.get(c.id) ?? [];
    }
    return comments;
  }

  async getCommentById(
    id: string,
    organizationId: string,
  ): Promise<TaskBoardComment | null> {
    const row = await this.db
      .selectFrom("task_board_comments")
      .selectAll()
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();
    return row ? this.commentFromDbRow(row) : null;
  }

  async updateComment(
    id: string,
    organizationId: string,
    body: string,
  ): Promise<TaskBoardComment> {
    const row = await this.db
      .updateTable("task_board_comments")
      .set({ body, updated_at: new Date().toISOString() })
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.commentFromDbRow(row);
  }

  /** Delete a comment. Replies and comment attachments cascade in the DB. */
  async deleteComment(id: string, organizationId: string): Promise<void> {
    await this.db
      .deleteFrom("task_board_comments")
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .execute();
  }

  // --------------------------------------------------------------------------
  // Attachments
  // --------------------------------------------------------------------------

  async addAttachment(params: {
    organizationId: string;
    taskBoardItemId: string;
    commentId?: string | null;
    filename: string;
    mimeType: string;
    data: Uint8Array;
    by: string;
  }): Promise<TaskBoardAttachmentMeta> {
    const row = await this.db
      .insertInto("task_board_attachments")
      .values({
        id: generatePrefixedId("att"),
        organization_id: params.organizationId,
        task_board_item_id: params.taskBoardItemId,
        comment_id: params.commentId ?? null,
        filename: params.filename,
        mime_type: params.mimeType,
        size: params.data.byteLength,
        data: params.data,
        created_by: params.by,
        created_at: new Date().toISOString(),
      })
      .returning([
        "id",
        "task_board_item_id",
        "comment_id",
        "filename",
        "mime_type",
        "size",
        "created_by",
        "created_at",
      ])
      .executeTakeFirstOrThrow();
    return this.attachmentMetaFromDbRow(row);
  }

  /** All attachment metadata for a task (task-level and comment-level). */
  async listAttachments(
    taskBoardItemId: string,
    organizationId: string,
  ): Promise<TaskBoardAttachmentMeta[]> {
    const rows = await this.db
      .selectFrom("task_board_attachments")
      .select([
        "id",
        "task_board_item_id",
        "comment_id",
        "filename",
        "mime_type",
        "size",
        "created_by",
        "created_at",
      ])
      .where("organization_id", "=", organizationId)
      .where("task_board_item_id", "=", taskBoardItemId)
      .orderBy("created_at", "asc")
      .execute();
    return rows.map((row) => this.attachmentMetaFromDbRow(row));
  }

  /** Full attachment (metadata + bytes) — for the serving route only. */
  async getAttachment(
    id: string,
    organizationId: string,
  ): Promise<{ meta: TaskBoardAttachmentMeta; data: Uint8Array } | null> {
    const row = await this.db
      .selectFrom("task_board_attachments")
      .selectAll()
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();
    if (!row) return null;
    return { meta: this.attachmentMetaFromDbRow(row), data: row.data };
  }

  async deleteAttachment(id: string, organizationId: string): Promise<void> {
    await this.db
      .deleteFrom("task_board_attachments")
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .execute();
  }

  // --------------------------------------------------------------------------
  // Sprints
  // --------------------------------------------------------------------------

  async createSprint(params: {
    organizationId: string;
    name: string;
    state?: TaskBoardSprintState;
    startDate?: string | null;
    endDate?: string | null;
    by: string;
  }): Promise<TaskBoardSprint> {
    const now = new Date().toISOString();
    const row = await this.db
      .insertInto("task_board_sprints")
      .values({
        id: generatePrefixedId("sprint"),
        organization_id: params.organizationId,
        name: params.name,
        state: params.state ?? "planned",
        start_date: params.startDate ?? null,
        end_date: params.endDate ?? null,
        created_by: params.by,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.sprintFromDbRow(row);
  }

  async updateSprint(
    id: string,
    organizationId: string,
    data: {
      name?: string;
      state?: TaskBoardSprintState;
      startDate?: string | null;
      endDate?: string | null;
    },
  ): Promise<TaskBoardSprint> {
    const row = await this.db
      .updateTable("task_board_sprints")
      .set({
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.state !== undefined ? { state: data.state } : {}),
        ...(data.startDate !== undefined ? { start_date: data.startDate } : {}),
        ...(data.endDate !== undefined ? { end_date: data.endDate } : {}),
        updated_at: new Date().toISOString(),
      })
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.sprintFromDbRow(row);
  }

  /** Delete a sprint and unstamp its tasks (they fall back to the backlog). */
  async deleteSprint(id: string, organizationId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("task_board_items")
        .set({ sprint_id: null })
        .where("sprint_id", "=", id)
        .where("organization_id", "=", organizationId)
        .execute();
      await trx
        .deleteFrom("task_board_sprints")
        .where("id", "=", id)
        .where("organization_id", "=", organizationId)
        .execute();
    });
  }

  /** Sprints for the org — active first, then planned, then closed. */
  async listSprints(organizationId: string): Promise<TaskBoardSprint[]> {
    const rows = await this.db
      .selectFrom("task_board_sprints")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .orderBy("created_at", "desc")
      .execute();
    const order: Record<TaskBoardSprintState, number> = {
      active: 0,
      planned: 1,
      closed: 2,
    };
    return rows
      .map((row) => this.sprintFromDbRow(row))
      .sort((a, b) => order[a.state] - order[b.state]);
  }

  // --------------------------------------------------------------------------
  // Releases
  // --------------------------------------------------------------------------

  /** Create a release and stamp the given tasks with it, atomically. */
  async createRelease(params: {
    organizationId: string;
    title: string;
    notes?: string | null;
    taskIds: string[];
    by: string;
  }): Promise<TaskBoardRelease> {
    return await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto("task_board_releases")
        .values({
          id: generatePrefixedId("rel"),
          organization_id: params.organizationId,
          title: params.title,
          notes: params.notes ?? null,
          created_by: params.by,
          created_at: new Date().toISOString(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      if (params.taskIds.length > 0) {
        await trx
          .updateTable("task_board_items")
          .set({ release_id: row.id })
          .where("id", "in", params.taskIds)
          .where("organization_id", "=", params.organizationId)
          .execute();
      }
      return this.releaseFromDbRow(row);
    });
  }

  async listReleases(organizationId: string): Promise<TaskBoardRelease[]> {
    const rows = await this.db
      .selectFrom("task_board_releases")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .orderBy("created_at", "desc")
      .execute();
    return rows.map((row) => this.releaseFromDbRow(row));
  }

  /** Delete a release and unstamp its tasks. */
  async deleteRelease(id: string, organizationId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("task_board_items")
        .set({ release_id: null })
        .where("release_id", "=", id)
        .where("organization_id", "=", organizationId)
        .execute();
      await trx
        .deleteFrom("task_board_releases")
        .where("id", "=", id)
        .where("organization_id", "=", organizationId)
        .execute();
    });
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
      createdAt: toIso(row.created_at),
    }));
  }

  private commentFromDbRow(row: {
    id: string;
    task_board_item_id: string;
    parent_id: string | null;
    body: string;
    created_by: string;
    created_at: string | Date;
    updated_at: string | Date;
  }): TaskBoardComment {
    return {
      id: row.id,
      taskBoardItemId: row.task_board_item_id,
      parentId: row.parent_id,
      body: row.body,
      attachments: [],
      createdBy: row.created_by,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  private attachmentMetaFromDbRow(row: {
    id: string;
    task_board_item_id: string;
    comment_id: string | null;
    filename: string;
    mime_type: string;
    size: number;
    created_by: string;
    created_at: string | Date;
  }): TaskBoardAttachmentMeta {
    return {
      id: row.id,
      taskBoardItemId: row.task_board_item_id,
      commentId: row.comment_id,
      filename: row.filename,
      mimeType: row.mime_type,
      size: row.size,
      createdBy: row.created_by,
      createdAt: toIso(row.created_at),
    };
  }

  private sprintFromDbRow(row: {
    id: string;
    name: string;
    state: string;
    start_date: string | Date | null;
    end_date: string | Date | null;
    created_by: string;
    created_at: string | Date;
  }): TaskBoardSprint {
    return {
      id: row.id,
      name: row.name,
      state: row.state as TaskBoardSprintState,
      startDate: toIsoOrNull(row.start_date),
      endDate: toIsoOrNull(row.end_date),
      createdBy: row.created_by,
      createdAt: toIso(row.created_at),
    };
  }

  private releaseFromDbRow(row: {
    id: string;
    title: string;
    notes: string | null;
    created_by: string;
    created_at: string | Date;
  }): TaskBoardRelease {
    return {
      id: row.id,
      title: row.title,
      notes: row.notes,
      createdBy: row.created_by,
      createdAt: toIso(row.created_at),
    };
  }
}
