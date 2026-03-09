import type { Kysely } from "kysely";
import type { ServerPluginMigration } from "@decocms/bindings/server-plugin";

export const migration: ServerPluginMigration = {
  name: "002-execution-list-index",

  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createIndex("idx_wf_execution_org_created_at")
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
