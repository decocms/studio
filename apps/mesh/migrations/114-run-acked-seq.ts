import type { Kysely } from "kysely";

/**
 * Persist the contiguous publish-confirmed ackSeq floor for a run so a pod
 * restart or cross-pod reconnect doesn't re-ingest from seq 1.
 *
 * `run_acked_seq` is the highest seq with all seqs <= it publish-confirmed to
 * DECOPILOT_STREAMS. Written via a monotonic CAS (`SET run_acked_seq = $new
 * WHERE run_acked_seq IS NULL OR run_acked_seq < $new`) so only advances, never
 * regresses. Null for pre-existing rows and runs that haven't published yet.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("threads")
    .addColumn("run_acked_seq", "integer")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("threads").dropColumn("run_acked_seq").execute();
}
