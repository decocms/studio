/**
 * Migration 147: Drop the shared agent-sandbox tables (R2 of the #5240 revert).
 *
 * #5240 restored per-user hosted sandboxes and deleted every reader/writer of
 * `agent_sandbox_sessions` and `agent_sandbox_runner_state` (created by 137 and
 * 138 for the shared model). R1 deliberately left both tables in place so the
 * rollout had a rollback window; this is the follow-up that removes them.
 *
 * Worth doing rather than leaving them dormant: `agent_sandbox_runner_state.state`
 * holds plaintext credentials — an `x-access-token:ghs_…` clone URL, submodule
 * tokens, and the resolved env bag — and the table has no organization FK, so
 * nothing ever garbage-collects a row. Dormant rows are a standing secret leak,
 * not merely dead weight.
 *
 * Must ship in a separate release from #5240: dropping in the same release lets
 * a not-yet-rolled pod hit `relation "agent_sandbox_sessions" does not exist` on
 * SANDBOX_START, and migrations run from the app CMD (`settings/pipeline.ts`), so
 * there is no natural barrier between the two.
 *
 * `ifExists` keeps this a no-op for installs that never provisioned the shared
 * tables, and makes a partial re-run safe.
 */

import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Reverse creation order. Neither table is referenced by the other (137 has
  // no FKs; 138's only FK is to organization), so the order is tidiness, not a
  // dependency requirement. Indexes are dropped with their table.
  await db.schema.dropTable("agent_sandbox_sessions").ifExists().execute();
  await db.schema.dropTable("agent_sandbox_runner_state").ifExists().execute();
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // Intentionally irreversible, following the 084/097 precedent for retired
  // sandbox state. Recreating the schema would restore two empty tables that no
  // code reads — #5240 removed every consumer — while the rows themselves are
  // unrecoverable. Duplicating 137/138's DDL here would only create a second
  // copy to drift.
}
