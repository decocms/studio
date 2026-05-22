/**
 * Migration 079: Drop sandbox_runner_state rows for the retired `host`
 * runner.
 *
 * The `host` SandboxProvider was the local-dev shortcut that spawned the
 * sandbox daemon as a child of the mesh process. It has been retired in
 * favor of the laptop-side `deco link` daemon (auto-spawned by
 * `bun run dev --local-sandbox-provider`), which exercises the same
 * remote-cli + desktop code paths production uses.
 *
 * Any `runner_kind = 'host'` rows left in dev databases are orphaned
 * pointers to daemon PIDs/ports that no longer exist; the new code path
 * never reads them. Delete them so the table doesn't accumulate dead
 * state. Sandbox state is ephemeral by design — the runner rehydrates
 * from a healthy daemon, or provisions a new one on next ensure().
 */

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`delete from sandbox_runner_state where runner_kind = 'host'`.execute(
    db,
  );
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // Irreversible — the host runner is gone, restoring deleted rows
  // would point at processes that no longer exist.
}
