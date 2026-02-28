/**
 * Workflows Plugin - Workflow Collection Storage
 *
 * CRUD operations for workflow templates (workflow_collection table).
 */

import type { Kysely } from "kysely";
import type {
  WorkflowDatabase,
  WorkflowCollectionRow,
  NewWorkflowCollection,
} from "./types";
import { parseJson } from "../types";

export interface ParsedWorkflowCollection
  extends Omit<WorkflowCollectionRow, "steps"> {
  steps: unknown[];
}

function parseCollection(row: WorkflowCollectionRow): ParsedWorkflowCollection {
  return {
    ...row,
    steps: (parseJson(row.steps) as unknown[]) ?? [],
  };
}

export class WorkflowCollectionStorage {
  constructor(private db: Kysely<WorkflowDatabase>) {}

  async list(
    organizationId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<{ items: WorkflowCollectionRow[]; totalCount: number }> {
    const { limit = 50, offset = 0 } = options;

    const items = await this.db
      .selectFrom("workflow_collection")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .orderBy("created_at", "desc")
      .limit(limit)
      .offset(offset)
      .execute();

    const countResult = await this.db
      .selectFrom("workflow_collection")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("organization_id", "=", organizationId)
      .executeTakeFirstOrThrow();

    return { items, totalCount: Number(countResult.count) };
  }

  async getById(
    id: string,
    organizationId: string,
  ): Promise<ParsedWorkflowCollection | null> {
    const row = await this.db
      .selectFrom("workflow_collection")
      .selectAll()
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();

    return row ? parseCollection(row) : null;
  }

  async create(data: NewWorkflowCollection): Promise<ParsedWorkflowCollection> {
    await this.db.insertInto("workflow_collection").values(data).execute();

    const row = await this.db
      .selectFrom("workflow_collection")
      .selectAll()
      .where("id", "=", data.id)
      .executeTakeFirstOrThrow();

    return parseCollection(row);
  }

  async update(
    id: string,
    organizationId: string,
    data: {
      title?: string;
      description?: string | null;
      virtual_mcp_id?: string;
      steps?: string;
      updated_by?: string | null;
    },
  ): Promise<WorkflowCollectionRow> {
    await this.db
      .updateTable("workflow_collection")
      .set({
        ...data,
        updated_at: new Date().toISOString(),
      })
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .execute();

    return await this.db
      .selectFrom("workflow_collection")
      .selectAll()
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .executeTakeFirstOrThrow();
  }

  async delete(
    id: string,
    organizationId: string,
  ): Promise<WorkflowCollectionRow> {
    const row = await this.db
      .selectFrom("workflow_collection")
      .selectAll()
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .executeTakeFirstOrThrow();

    await this.db
      .deleteFrom("workflow_collection")
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .execute();

    return row;
  }
}
