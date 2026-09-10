import { type Kysely, sql } from "kysely";

/**
 * `organization_notices` — the billing notice a deployment admin pins on an
 * organization: a `warn` renders a banner over the org, a `block` replaces the
 * org's UI and refuses control-plane writes until it is resolved.
 *
 * Not an entry in `organization_settings.flags`: the notice carries text, a
 * call to action and provenance, and flags are a boolean bag by contract.
 *
 * At most one notice is live per org (partial unique index on the unresolved
 * rows). Escalating a warning to a block edits `severity` on that row rather
 * than adding a second one, and resolving stamps `resolved_at` instead of
 * deleting, so the history of what an org was told survives.
 *
 * `source` separates a notice typed by a human from one an invoice sync writes,
 * so the sync that comes later can leave a manual notice alone.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("organization_notices")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("severity", "text", (col) =>
      col.notNull().check(sql`severity IN ('warn', 'block')`),
    )
    .addColumn("title", "text", (col) => col.notNull())
    .addColumn("message", "text", (col) => col.notNull())
    .addColumn("cta_label", "text")
    .addColumn("cta_url", "text")
    .addColumn("source", "text", (col) => col.notNull().defaultTo("manual"))
    .addColumn("resolved_at", "timestamptz")
    .addColumn("resolved_by", "text")
    .addColumn("created_by", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_by", "text", (col) => col.notNull())
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  // One live notice per org. Partial, so resolved rows accumulate freely.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS organization_notices_active_uniq
      ON organization_notices (organization_id)
      WHERE resolved_at IS NULL
  `.execute(db);

  // The read the gate makes on a cache miss: org → its live notice.
  await sql`
    CREATE INDEX IF NOT EXISTS organization_notices_org_created_idx
      ON organization_notices (organization_id, created_at DESC)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("organization_notices").ifExists().execute();
}
