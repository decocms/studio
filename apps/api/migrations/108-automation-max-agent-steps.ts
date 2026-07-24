import { type Kysely } from "kysely";

/**
 * Per-automation agent step limit. Caps the parent agent loop's number of
 * reasoning/tool steps (the AI SDK `stopWhen: stepCountIs(...)` value). `null`
 * (the default) means "use the platform default" (`PARENT_STEP_LIMIT`), so
 * existing automations are untouched.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("automations")
    .addColumn("max_agent_steps", "integer") // null = PARENT_STEP_LIMIT default
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("automations")
    .dropColumn("max_agent_steps")
    .execute();
}
