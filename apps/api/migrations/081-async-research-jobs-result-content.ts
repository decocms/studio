/**
 * Adds `result_content` to `async_research_jobs` so inline-sized
 * completed jobs retain their full report text. The existing
 * `result_preview` column stayed truncated by `createOutputPreview`,
 * which meant DBOS step replays of completed runs returned a partial
 * report instead of the original — silent data loss for any caller
 * that re-entered the tool with the same tool_call_id.
 *
 * Semantics:
 *   - `result_content`: full text for inline results (NULL when the
 *     report was offloaded to blob storage via `result_uri`).
 *   - `result_preview`: short snippet for SQL-side inspection, always
 *     populated on terminal-success transitions.
 *   - `result_uri`: blob-storage URI for large reports.
 *
 * No backfill: rows completed before this migration ran are stuck with
 * only their truncated preview. That's acceptable — the bug only
 * manifests on replay of a specific tool_call_id, which is rare and
 * the row's status='completed' still tells the auditor what happened.
 */
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("async_research_jobs")
    .addColumn("result_content", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("async_research_jobs")
    .dropColumn("result_content")
    .execute();
}
