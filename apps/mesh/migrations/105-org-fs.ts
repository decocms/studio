import { type Kysely, sql } from "kysely";

/**
 * Org filesystem manifest. Indexes the org-prefixed object-storage keyspace
 * under `_fs/{volume}/...` with path/tree semantics so the sandbox mount can
 * (a) list directories without downloading bytes and (b) drive a change feed
 * for lazy cache invalidation. Raw bytes still live in object storage; this is
 * metadata + the conflict/version oracle only. See
 * `.context/org-filesystem-proposal.md`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Single global monotonic counter. The change feed filters by (org, volume)
  // and orders by `seq`, so a shared sequence is fine — gaps across volumes
  // are irrelevant to a per-volume cursor.
  await sql`CREATE SEQUENCE IF NOT EXISTS org_fs_entry_seq`.execute(db);

  await db.schema
    .createTable("org_fs_entry")
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("volume", "text", (col) => col.notNull())
    // Normalized path, no leading/trailing slash. "" is the volume root.
    .addColumn("path", "text", (col) => col.notNull())
    // Parent directory path ("" for top-level entries). Drives listDir.
    .addColumn("parent", "text", (col) => col.notNull())
    .addColumn("kind", "text", (col) =>
      col.notNull().check(sql`kind in ('file', 'dir')`),
    )
    // sha256 of the bytes for files; null for dirs.
    .addColumn("content_hash", "text")
    .addColumn("size", "bigint", (col) => col.notNull().defaultTo(0))
    // Monotonic change-feed cursor. Bumped on every create/update/tombstone.
    .addColumn("seq", "bigint", (col) =>
      col.notNull().defaultTo(sql`nextval('org_fs_entry_seq')`),
    )
    // Tombstone: set when deleted so the change feed can propagate removals.
    .addColumn("deleted_at", "timestamptz")
    .addColumn("created_by", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("updated_by", "text", (col) => col.notNull())
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addPrimaryKeyConstraint("org_fs_entry_pk", [
      "organization_id",
      "volume",
      "path",
    ])
    .execute();

  // Change feed: "what changed in this volume since cursor".
  await db.schema
    .createIndex("idx_org_fs_entry_changes")
    .on("org_fs_entry")
    .columns(["organization_id", "volume", "seq"])
    .execute();

  // Directory listing by parent — partial on live entries, matching the
  // listDir query (`... AND deleted_at IS NULL`) so tombstones don't bloat it.
  await sql`
    CREATE INDEX idx_org_fs_entry_parent
    ON org_fs_entry (organization_id, volume, parent)
    WHERE deleted_at IS NULL
  `.execute(db);

  // Usage / quota aggregation: SUM(size) over live files per volume (run on
  // every write). Partial + size-carrying so it answers without touching rows.
  await sql`
    CREATE INDEX idx_org_fs_entry_usage
    ON org_fs_entry (organization_id, volume, size)
    WHERE kind = 'file' AND deleted_at IS NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("org_fs_entry").execute();
  await sql`DROP SEQUENCE IF EXISTS org_fs_entry_seq`.execute(db);
}
