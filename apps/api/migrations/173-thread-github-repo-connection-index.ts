import { sql, type Kysely } from "kysely";

/**
 * `Connections.isReferencedByThread()` (called on every delete of a
 * repo-backed virtual MCP connection) scans `threads` filtering on
 * `metadata -> 'githubRepo' ->> 'connectionId'` with no index behind it —
 * a full table scan of `threads`, which grows unbounded. This adds a
 * partial expression index on that exact predicate so the lookup becomes
 * an index scan instead.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX IF NOT EXISTS idx_threads_github_repo_connection_id
    ON threads ((metadata -> 'githubRepo' ->> 'connectionId'))
    WHERE metadata -> 'githubRepo' ->> 'connectionId' IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_threads_github_repo_connection_id`.execute(
    db,
  );
}
