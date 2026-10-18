/**
 * Repository briefs: what a repository is for, rebuilt daily by repository
 * upkeep (`src/repo-upkeep/`). One row per repository, deleted with it.
 *
 * `brief` and `built_at` describe the last GOOD build; a failed attempt only
 * moves `attempted_at` and sets `error`, so a failure never replaces a good
 * brief and doubles as the short negative cache.
 */

import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("repository_briefs")
    .addColumn("repository_id", "text", (col) =>
      col.primaryKey().references("repositories.id").onDelete("cascade"),
    )
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("head_sha", "text")
    .addColumn("brief", "jsonb")
    .addColumn("built_at", "timestamptz")
    .addColumn("attempted_at", "timestamptz", (col) => col.notNull())
    .addColumn("error", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("repository_briefs").ifExists().execute();
}
