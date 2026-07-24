import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Registry items
  await db.schema
    .createTable("private_registry_item")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("title", "text", (col) => col.notNull())
    .addColumn("description", "text")
    .addColumn("server_json", "text", (col) => col.notNull())
    .addColumn("meta_json", "text")
    .addColumn("tags", "text")
    .addColumn("categories", "text")
    .addColumn("is_public", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("updated_at", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("created_by", "text", (col) =>
      col.references("user.id").onDelete("set null"),
    )
    .execute();

  await db.schema
    .createIndex("idx_private_registry_item_org")
    .ifNotExists()
    .on("private_registry_item")
    .column("organization_id")
    .execute();

  await db.schema
    .createIndex("idx_private_registry_item_org_public")
    .ifNotExists()
    .on("private_registry_item")
    .columns(["organization_id", "is_public"])
    .execute();

  await sql`ALTER TABLE private_registry_item ADD COLUMN IF NOT EXISTS is_unlisted integer NOT NULL DEFAULT 0`.execute(
    db,
  );

  // Publish requests
  await db.schema
    .createTable("private_registry_publish_request")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("title", "text", (col) => col.notNull())
    .addColumn("description", "text")
    .addColumn("server_json", "text", (col) => col.notNull())
    .addColumn("meta_json", "text")
    .addColumn("requester_name", "text")
    .addColumn("requester_email", "text")
    .addColumn("reviewer_notes", "text")
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("updated_at", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  await db.schema
    .createIndex("idx_private_registry_publish_request_org_status")
    .ifNotExists()
    .on("private_registry_publish_request")
    .columns(["organization_id", "status"])
    .execute();

  await sql`ALTER TABLE private_registry_publish_request ADD COLUMN IF NOT EXISTS requested_id text`.execute(
    db,
  );

  // Publish API keys
  await db.schema
    .createTable("private_registry_publish_api_key")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("key_hash", "text", (col) => col.notNull())
    .addColumn("prefix", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  await db.schema
    .createIndex("idx_private_registry_publish_api_key_org")
    .ifNotExists()
    .on("private_registry_publish_api_key")
    .columns(["organization_id"])
    .execute();

  // Monitor runs
  await db.schema
    .createTable("private_registry_monitor_run")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("config_snapshot", "text")
    .addColumn("total_items", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("tested_items", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("passed_items", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("failed_items", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("skipped_items", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("current_item_id", "text")
    .addColumn("started_at", "text")
    .addColumn("finished_at", "text")
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  await db.schema
    .createIndex("idx_private_registry_monitor_run_org_created")
    .ifNotExists()
    .on("private_registry_monitor_run")
    .columns(["organization_id", "created_at"])
    .execute();

  // Monitor results
  await db.schema
    .createTable("private_registry_monitor_result")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("run_id", "text", (col) =>
      col
        .notNull()
        .references("private_registry_monitor_run.id")
        .onDelete("cascade"),
    )
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("item_id", "text", (col) => col.notNull())
    .addColumn("item_title", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("error_message", "text")
    .addColumn("connection_ok", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("tools_listed", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("tool_results", "text")
    .addColumn("agent_summary", "text")
    .addColumn("duration_ms", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("action_taken", "text", (col) => col.notNull().defaultTo("none"))
    .addColumn("tested_at", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  await db.schema
    .createIndex("idx_private_registry_monitor_result_run")
    .ifNotExists()
    .on("private_registry_monitor_result")
    .columns(["run_id", "tested_at"])
    .execute();

  await db.schema
    .createIndex("idx_private_registry_monitor_result_run_status")
    .ifNotExists()
    .on("private_registry_monitor_result")
    .columns(["run_id", "status"])
    .execute();

  // Monitor connections
  await db.schema
    .createTable("private_registry_monitor_connection")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("item_id", "text", (col) => col.notNull())
    .addColumn("connection_id", "text", (col) =>
      col.notNull().references("connections.id").onDelete("cascade"),
    )
    .addColumn("auth_status", "text", (col) => col.notNull().defaultTo("none"))
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("updated_at", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  await db.schema
    .createIndex("idx_private_registry_monitor_connection_org_item")
    .ifNotExists()
    .on("private_registry_monitor_connection")
    .columns(["organization_id", "item_id"])
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .dropIndex("idx_private_registry_monitor_connection_org_item")
    .ifExists()
    .execute();
  await db.schema
    .dropTable("private_registry_monitor_connection")
    .ifExists()
    .execute();
  await db.schema
    .dropIndex("idx_private_registry_monitor_result_run_status")
    .ifExists()
    .execute();
  await db.schema
    .dropIndex("idx_private_registry_monitor_result_run")
    .ifExists()
    .execute();
  await db.schema
    .dropTable("private_registry_monitor_result")
    .ifExists()
    .execute();
  await db.schema
    .dropIndex("idx_private_registry_monitor_run_org_created")
    .ifExists()
    .execute();
  await db.schema
    .dropTable("private_registry_monitor_run")
    .ifExists()
    .execute();
  await db.schema
    .dropIndex("idx_private_registry_publish_api_key_org")
    .ifExists()
    .execute();
  await db.schema
    .dropTable("private_registry_publish_api_key")
    .ifExists()
    .execute();
  await db.schema
    .dropIndex("idx_private_registry_publish_request_org_status")
    .ifExists()
    .execute();
  await db.schema
    .dropTable("private_registry_publish_request")
    .ifExists()
    .execute();
  await db.schema
    .dropIndex("idx_private_registry_item_org_public")
    .ifExists()
    .execute();
  await db.schema
    .dropIndex("idx_private_registry_item_org")
    .ifExists()
    .execute();
  await db.schema.dropTable("private_registry_item").ifExists().execute();
}
