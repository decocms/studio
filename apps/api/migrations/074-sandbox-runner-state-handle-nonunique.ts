/**
 * The original `sandbox_runner_state_handle_idx` was UNIQUE across all rows,
 * but `handle` is only guaranteed unique within a runner's namespace (e.g.
 * a K8s claim namespace for agent-sandbox, or a Docker host for the docker
 * runner). With 5 hex chars of hash entropy on no-branch sandboxes (~20 bits),
 * two different users can legitimately collide — triggering a constraint
 * violation on insert. Drop and recreate as a non-unique index.
 *
 * `getByHandle` uses executeTakeFirst() and handles are still random enough
 * that collisions are rare; the DB uniqueness was never load-bearing for
 * correctness.
 */
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("sandbox_runner_state_handle_idx").execute();
  await db.schema
    .createIndex("sandbox_runner_state_handle_idx")
    .on("sandbox_runner_state")
    .column("handle")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("sandbox_runner_state_handle_idx").execute();
  await db.schema
    .createIndex("sandbox_runner_state_handle_idx")
    .on("sandbox_runner_state")
    .column("handle")
    .unique()
    .execute();
}
