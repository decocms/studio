/**
 * Workflow Collection Storage
 *
 * CRUD operations for workflow templates (workflow_collection table).
 */

import type { Kysely } from "kysely";
import type {
  WorkflowDatabase,
  WorkflowCollectionRow,
  NewWorkflowCollection,
} from "./types";
import { parseJson } from "./json";

export interface ParsedWorkflowCollection
  extends Omit<WorkflowCollectionRow, "steps" | "input_schema"> {
  steps: unknown[];
  input_schema: Record<string, unknown> | null;
}

function parseCollection(row: WorkflowCollectionRow): ParsedWorkflowCollection {
  return {
    ...row,
    steps: (parseJson(row.steps) as unknown[]) ?? [],
    input_schema:
      (parseJson(row.input_schema) as Record<string, unknown>) ?? null,
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

  async create(
    data: Omit<NewWorkflowCollection, "input_schema"> & {
      input_schema?: Record<string, unknown> | null;
    },
  ): Promise<ParsedWorkflowCollection> {
    const { input_schema, ...rest } = data;
    const row = await this.db
      .insertInto("workflow_collection")
      .values({
        ...rest,
        input_schema:
          input_schema != null ? JSON.stringify(input_schema) : null,
      })
      .returningAll()
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
      input_schema?: Record<string, unknown> | null;
      updated_by?: string | null;
    },
  ): Promise<WorkflowCollectionRow> {
    const { input_schema, ...rest } = data;
    const setValues: Record<string, unknown> = {
      ...rest,
      updated_at: new Date().toISOString(),
    };
    if (input_schema !== undefined)
      setValues.input_schema = input_schema
        ? JSON.stringify(input_schema)
        : null;

    return await this.db
      .updateTable("workflow_collection")
      .set(setValues)
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async delete(
    id: string,
    organizationId: string,
  ): Promise<WorkflowCollectionRow> {
    return await this.db
      .deleteFrom("workflow_collection")
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
