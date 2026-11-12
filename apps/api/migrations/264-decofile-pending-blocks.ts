import { type Kysely, sql } from "kysely";

/**
 * Migration 264 — Fast Preview saves held in Studio instead of committed.
 *
 * With the org's `cms_auto_commit` flag off, a CMS save on a Fast Preview
 * branch is stored here, one row per block, instead of becoming a commit. The
 * decofile read lays these rows over the branch head, so the editor and the
 * preview see them; publishing commits them to the branch and deletes them.
 * `content` is the block's JSON as text, not jsonb, so the committed file
 * keeps the editor's key order; NULL means the block was deleted. `revision`
 * is reassigned on each write, so a commit deletes only the rows it carried
 * and leaves a newer save pending. Rows go away with their organization or
 * project.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE SEQUENCE IF NOT EXISTS decofile_pending_blocks_revision_seq`.execute(
    db,
  );
  await db.schema
    .createTable("decofile_pending_blocks")
    .ifNotExists()
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("virtual_mcp_id", "text", (col) =>
      col.notNull().references("connections.id").onDelete("cascade"),
    )
    .addColumn("branch", "text", (col) => col.notNull())
    .addColumn("block_key", "text", (col) => col.notNull())
    .addColumn("content", "text")
    .addColumn("revision", "bigint", (col) =>
      col
        .notNull()
        .defaultTo(sql`nextval('decofile_pending_blocks_revision_seq')`),
    )
    .addColumn("updated_by", "text")
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint("decofile_pending_blocks_pkey", [
      "organization_id",
      "virtual_mcp_id",
      "branch",
      "block_key",
    ])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("decofile_pending_blocks").ifExists().execute();
  await sql`DROP SEQUENCE IF EXISTS decofile_pending_blocks_revision_seq`.execute(
    db,
  );
}
