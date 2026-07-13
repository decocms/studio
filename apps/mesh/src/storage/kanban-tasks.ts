/**
 * Kanban Task Storage Implementation
 *
 * Handles CRUD operations for org-scoped kanban board cards.
 */

import type { Kysely } from "kysely";
import type {
  Database,
  KanbanTask,
  KanbanTaskPriority,
  KanbanTaskStatus,
} from "./types";
import { generatePrefixedId } from "@/shared/utils/generate-id";

export class KanbanTaskStorage {
  constructor(private db: Kysely<Database>) {}

  async list(organizationId: string): Promise<KanbanTask[]> {
    const rows = await this.db
      .selectFrom("kanban_tasks")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .orderBy("created_at", "desc")
      .execute();

    return rows.map((row) => this.taskFromDbRow(row));
  }

  async getById(
    id: string,
    organizationId: string,
  ): Promise<KanbanTask | null> {
    const row = await this.db
      .selectFrom("kanban_tasks")
      .selectAll()
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();

    return row ? this.taskFromDbRow(row) : null;
  }

  async create(params: {
    organizationId: string;
    title: string;
    description?: string | null;
    status?: KanbanTaskStatus;
    priority?: KanbanTaskPriority;
    assigneeId?: string | null;
    by: string;
  }): Promise<KanbanTask> {
    const id = generatePrefixedId("ktask");
    const now = new Date().toISOString();

    const row = await this.db
      .insertInto("kanban_tasks")
      .values({
        id,
        organization_id: params.organizationId,
        title: params.title,
        description: params.description ?? null,
        status: params.status ?? "triage",
        priority: params.priority ?? "medium",
        assignee_id: params.assigneeId ?? null,
        created_by: params.by,
        created_at: now,
        updated_by: params.by,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.taskFromDbRow(row);
  }

  async update(
    id: string,
    organizationId: string,
    data: {
      title?: string;
      description?: string | null;
      status?: KanbanTaskStatus;
      priority?: KanbanTaskPriority;
      assigneeId?: string | null;
    },
    by: string,
  ): Promise<KanbanTask> {
    const row = await this.db
      .updateTable("kanban_tasks")
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
        updated_by: by,
        updated_at: new Date().toISOString(),
      })
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.taskFromDbRow(row);
  }

  async delete(id: string, organizationId: string): Promise<void> {
    await this.db
      .deleteFrom("kanban_tasks")
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .execute();
  }

  private taskFromDbRow(row: {
    id: string;
    organization_id: string;
    title: string;
    description: string | null;
    status: string;
    priority: string;
    assignee_id: string | null;
    created_by: string;
    created_at: string | Date;
    updated_by: string;
    updated_at: string | Date;
  }): KanbanTask {
    return {
      id: row.id,
      organizationId: row.organization_id,
      title: row.title,
      description: row.description,
      status: row.status as KanbanTaskStatus,
      priority: row.priority as KanbanTaskPriority,
      assigneeId: row.assignee_id,
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
