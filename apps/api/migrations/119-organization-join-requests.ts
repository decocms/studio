import { type Kysely, sql } from "kysely";

/**
 * Generic membership-request mechanism: a user asks to join an org and an admin
 * approves or denies. The first (and currently only) public entry point is the
 * domain-gated request-to-join flow, but the table itself is org-agnostic.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("organization_join_requests")
    .addColumn("id", "text", (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()::text`),
    )
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("user_id", "text", (col) =>
      col.notNull().references("user.id").onDelete("cascade"),
    )
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("decided_by", "text", (col) =>
      col.references("user.id").onDelete("set null"),
    )
    .addColumn("decided_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  // At most one pending request per (org, user).
  await sql`
    CREATE UNIQUE INDEX organization_join_requests_pending_unique
    ON organization_join_requests (organization_id, user_id)
    WHERE status = 'pending'
  `.execute(db);

  // List pending requests for an org.
  await db.schema
    .createIndex("organization_join_requests_org_status_idx")
    .on("organization_join_requests")
    .columns(["organization_id", "status"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("organization_join_requests").execute();
}
