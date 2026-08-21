import { sql, type Kysely } from "kysely";

/**
 * `thread_message_parts.created_at` is an ORDERING key, not a clock: the
 * emitter derives it as `base + seq` so the fold keeps user-before-assistant
 * order stable (see `part-emitter.ts`). Every part of a run therefore carries a
 * timestamp within milliseconds of run start, even when the row lands minutes
 * later — which makes projector lag unmeasurable from the database. This adds a
 * separate wall-clock column stamped by Postgres at INSERT.
 *
 * Two-step on purpose: `ADD COLUMN ... DEFAULT now()` would rewrite the whole
 * table (a volatile default defeats PG's metadata-only fast path). Adding the
 * column nullable first is instant; the default then applies to new rows only.
 * Pre-existing rows stay NULL — we genuinely don't know when they were written.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE thread_message_parts
    ADD COLUMN IF NOT EXISTS persisted_at timestamptz
  `.execute(db);
  await sql`
    ALTER TABLE thread_message_parts
    ALTER COLUMN persisted_at SET DEFAULT now()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE thread_message_parts DROP COLUMN IF EXISTS persisted_at
  `.execute(db);
}
