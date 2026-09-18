import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("demo_organizations")
    .addColumn("organization_id", "text", (c) =>
      c.primaryKey().references("organization.id").onDelete("cascade"),
    )
    .addColumn("scenario", "text", (c) => c.notNull())
    .addColumn("generation", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("reset_at", "timestamptz", (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .addColumn("session_owner", "text", (c) =>
      c.references("user.id").onDelete("set null"),
    )
    .addColumn("session_expires_at", "timestamptz")
    .execute();
  await db.schema
    .createTable("demo_tasks")
    .addColumn("task_id", "text", (c) =>
      c.primaryKey().references("task_board_items.id").onDelete("cascade"),
    )
    .addColumn("organization_id", "text", (c) =>
      c
        .notNull()
        .references("demo_organizations.organization_id")
        .onDelete("cascade"),
    )
    .addColumn("recipe", "text", (c) => c.notNull())
    .addColumn("delivered", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("published", "boolean", (c) => c.notNull().defaultTo(false))
    .execute();
  await db.schema
    .createTable("demo_runs")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("organization_id", "text", (c) =>
      c
        .notNull()
        .references("demo_organizations.organization_id")
        .onDelete("cascade"),
    )
    .addColumn("generation", "integer", (c) => c.notNull())
    .addColumn("task_id", "text", (c) =>
      c.notNull().references("task_board_items.id").onDelete("cascade"),
    )
    .addColumn("thread_id", "text", (c) =>
      c.notNull().references("threads.id").onDelete("cascade"),
    )
    .addColumn("recipe", "text", (c) => c.notNull())
    .addColumn("step", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("state", "text", (c) => c.notNull().defaultTo("pending"))
    .addColumn("created_at", "timestamptz", (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .execute();
  await db.schema
    .createIndex("demo_runs_pending")
    .on("demo_runs")
    .columns(["state", "organization_id"])
    .execute();
  await db.schema
    .createTable("demo_resets")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("organization_id", "text", (c) =>
      c
        .notNull()
        .references("demo_organizations.organization_id")
        .onDelete("cascade"),
    )
    .addColumn("idempotency_key", "text", (c) => c.notNull())
    .addColumn("generation", "integer", (c) => c.notNull())
    .addColumn("actor_id", "text", (c) =>
      c.references("user.id").onDelete("set null"),
    )
    .addColumn("created_at", "timestamptz", (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .addUniqueConstraint("demo_reset_idempotency", [
      "organization_id",
      "idempotency_key",
    ])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of [
    "demo_resets",
    "demo_runs",
    "demo_tasks",
    "demo_organizations",
  ]) {
    await db.schema.dropTable(table).execute();
  }
}
