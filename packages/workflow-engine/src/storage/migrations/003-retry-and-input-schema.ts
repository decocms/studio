import type { Kysely } from "kysely";
import type { EngineMigration } from "./index";

export const migration: EngineMigration = {
  name: "003-retry-and-input-schema",
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .alterTable("workflow_execution_step_result")
      .addColumn("attempt_number", "integer", (col) =>
        col.notNull().defaultTo(1),
      )
      .execute();

    await db.schema
      .alterTable("workflow_collection")
      .addColumn("input_schema", "text")
      .execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .alterTable("workflow_execution_step_result")
      .dropColumn("attempt_number")
      .execute();

    await db.schema
      .alterTable("workflow_collection")
      .dropColumn("input_schema")
      .execute();
  },
};
