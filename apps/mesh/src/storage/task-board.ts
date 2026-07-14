/**
 * Task Board Storage Implementation
 *
 * Handles CRUD operations for org-scoped task board items.
 */

import type { Kysely } from "kysely";
import type {
  Database,
  TaskBoardItem,
  TaskBoardItemPriority,
  TaskBoardItemStatus,
} from "./types";
import { generatePrefixedId } from "@/shared/utils/generate-id";

export class TaskBoardStorage {
  constructor(private db: Kysely<Database>) {}

  async list(organizationId: string): Promise<TaskBoardItem[]> {
    const rows = await this.db
      .selectFrom("task_board_items")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .orderBy("created_at", "desc")
      .execute();

    return rows.map((row) => this.itemFromDbRow(row));
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

    return row ? this.itemFromDbRow(row) : null;
  }

  async create(params: {
    organizationId: string;
    title: string;
    description?: string | null;
    status?: TaskBoardItemStatus;
    priority?: TaskBoardItemPriority;
    assigneeId?: string | null;
    dueDate?: string | null;
    by: string;
  }): Promise<TaskBoardItem> {
    const id = generatePrefixedId("board");
    const now = new Date().toISOString();

    const row = await this.db
      .insertInto("task_board_items")
      .values({
        id,
        organization_id: params.organizationId,
        title: params.title,
        description: params.description ?? null,
        status: params.status ?? "triage",
        priority: params.priority ?? "medium",
        assignee_id: params.assigneeId ?? null,
        due_date: params.dueDate ?? null,
        created_by: params.by,
        created_at: now,
        updated_by: params.by,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

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
      dueDate?: string | null;
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
        ...(data.dueDate !== undefined ? { due_date: data.dueDate } : {}),
        updated_by: by,
        updated_at: new Date().toISOString(),
      })
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.itemFromDbRow(row);
  }

  async delete(id: string, organizationId: string): Promise<void> {
    await this.db
      .deleteFrom("task_board_items")
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .execute();
  }

  private itemFromDbRow(row: {
    id: string;
    organization_id: string;
    title: string;
    description: string | null;
    status: string;
    priority: string;
    assignee_id: string | null;
    due_date: string | Date | null;
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
      dueDate:
        row.due_date instanceof Date
          ? row.due_date.toISOString()
          : row.due_date,
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
