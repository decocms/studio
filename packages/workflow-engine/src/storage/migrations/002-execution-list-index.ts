import type { Kysely } from "kysely";
import type { EngineMigration } from "./index";

export const migration: EngineMigration = {
  name: "002-execution-list-index",

  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createIndex("idx_wf_execution_org_created_at")
      .ifNotExists()
      .on("workflow_execution")
      .columns(["organization_id", "created_at desc"])
      .execute();
  },

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .dropIndex("idx_wf_execution_org_created_at")
      .ifExists()
      .execute();
  },
};
