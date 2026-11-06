import { type Kysely, sql } from "kysely";

/**
 * Migration 263 — the hosted CMS's named drafts.
 *
 * A site has many named drafts; each is a public folder on the delivery
 * bucket at `sites/<site>/drafts/<slug>/` (an index plus one file per block),
 * with a random slug (holding its URL is the permission to read it). This table maps a draft's name to
 * that slug and records who made it and how (`via`, set by the server from
 * the auth method). It replaces the KV entry `v8-draft:<project>:<branch>`.
 * Unique on (site, name): creating a draft inserts the row when it is
 * absent, and the loser of a race reads the winner's row. Listing a site's
 * drafts is a query here, for `deco drafts list` and Studio alike.
 * Discarding deletes the folder's files and the row. Releasing a site (deleting
 * its `org_sites` row) deletes its draft rows with it (ON DELETE CASCADE).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("drafts")
    .ifNotExists()
    .addColumn("site", "text", (col) =>
      col.notNull().references("org_sites.slug").onDelete("cascade"),
    )
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("slug", "text", (col) => col.notNull().unique())
    .addColumn("created_by", "text", (col) => col.notNull())
    .addColumn("via", "text", (col) =>
      col.notNull().check(sql`via IN ('studio','cli','token','studio-agent')`),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint("drafts_pkey", ["site", "name"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("drafts").ifExists().execute();
}
