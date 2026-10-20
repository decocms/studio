import { type Kysely, sql } from "kysely";

/**
 * The starter of the built-in "Move cards from linked chats":
 * `linked_chat_run`, a run on a thread linked to a card that is not the
 * Implementer's.
 *
 * The allowed types are read back from the constraint, as in migration 247.
 */
const ADDED = ["linked_chat_run"];

async function triggerTypes(db: Kysely<unknown>): Promise<Set<string>> {
  const { rows } = await sql<{ def: string }>`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conname = 'chk_trigger_type'
       AND conrelid = 'automation_triggers'::regclass
  `.execute(db);
  return new Set(
    [...(rows[0]?.def ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!),
  );
}

async function setTriggerTypes(
  db: Kysely<unknown>,
  types: Set<string>,
): Promise<void> {
  const list = sql.join([...types].map((type) => sql.lit(type)));
  await sql`
    ALTER TABLE automation_triggers DROP CONSTRAINT chk_trigger_type,
      ADD CONSTRAINT chk_trigger_type CHECK (type IN (${list}))
  `.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const types = await triggerTypes(db);
  if (ADDED.every((type) => types.has(type))) return;
  for (const type of ADDED) types.add(type);
  await setTriggerTypes(db, types);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM automation_triggers WHERE type IN (${sql.join(ADDED)})`.execute(
    db,
  );
  const types = await triggerTypes(db);
  for (const type of ADDED) types.delete(type);
  await setTriggerTypes(db, types);
}
