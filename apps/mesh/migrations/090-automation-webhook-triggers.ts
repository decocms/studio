/**
 * Adds support for `webhook` automation triggers.
 *
 * - Extends the `automation_triggers.type` check to allow `'webhook'`.
 * - Adds `api_key_id` column referencing the Better Auth `apikey.id` used to
 *   authenticate inbound webhook POSTs. Nullable because cron/event triggers
 *   don't use it.
 *
 * Webhook triggers store their token as a Better Auth API key (see
 * `apps/mesh/src/tools/automations/trigger-add.ts` and the
 * `/api/:org/webhooks/:triggerId` route). The api key id is kept here so
 * the trigger can rotate or revoke its key on update/remove.
 */

import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Relax the trigger type check to include webhook.
  await sql`ALTER TABLE automation_triggers DROP CONSTRAINT chk_trigger_type`.execute(
    db,
  );
  await sql`ALTER TABLE automation_triggers ADD CONSTRAINT chk_trigger_type CHECK (type IN ('cron', 'event', 'webhook'))`.execute(
    db,
  );

  await db.schema
    .alterTable("automation_triggers")
    .addColumn("api_key_id", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("automation_triggers")
    .dropColumn("api_key_id")
    .execute();

  // Restoring the narrower CHECK requires every row to have type IN
  // ('cron', 'event'). Any webhook rows would block this, so the down
  // migration deletes them before re-applying the constraint.
  await sql`DELETE FROM automation_triggers WHERE type = 'webhook'`.execute(db);

  await sql`ALTER TABLE automation_triggers DROP CONSTRAINT chk_trigger_type`.execute(
    db,
  );
  await sql`ALTER TABLE automation_triggers ADD CONSTRAINT chk_trigger_type CHECK (type IN ('cron', 'event'))`.execute(
    db,
  );
}
