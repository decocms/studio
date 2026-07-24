import { sql, type Kysely } from "kysely";

/**
 * Removes the sentinel rows created by the deprecated
 * `AI_PROVIDER_CLI_ACTIVATE` tool. These rows always had
 * `api_key = 'cli-local'` and never represented a real credential —
 * they were a marker the dialog used to render a "Claude CLI" /
 * "Codex CLI" entry in the connected-providers list.
 *
 * Capability discovery now lives on the laptop link, so the rows are
 * vestigial. No downstream code reads them after the cli-activate path
 * is deleted.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM ai_provider_keys
    WHERE provider_id IN ('claude-code', 'codex')
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // No rollback — the rows were sentinels and the upstream code that
  // created them no longer exists. If a rollback is ever needed, the
  // user can re-run AI Providers onboarding manually (against a build
  // that still has the cli-activate path).
}
