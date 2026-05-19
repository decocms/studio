/**
 * `mesh_pods` — registry of currently-live pod ids.
 *
 * Each mesh pod inserts its row on boot (`INSERT ... ON CONFLICT DO
 * NOTHING`) and deletes on graceful stop. The Postgres-advisory-lock
 * heartbeat (apps/mesh/src/nats/pod-heartbeat.ts → PgPodHeartbeat)
 * uses this table to enumerate peer pods to probe — surveying every
 * row and trying `pg_try_advisory_lock(hashtext(pod_id))` to detect
 * the ones whose owner is gone.
 *
 * Single-column on purpose: peer-death recovery cares about the set
 * of pod ids and nothing else. Any timestamps would just rot since
 * the advisory lock IS the liveness signal.
 */
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("mesh_pods")
    .addColumn("pod_id", "text", (col) => col.primaryKey())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("mesh_pods").execute();
}
