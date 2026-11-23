import { type Kysely, sql } from "kysely";

/**
 * Plan goals (docs/plans/plan-goals.md): the org's list of goals, the goal
 * each member works toward, and which business case went toward which goal.
 *
 * - `plan_goals`: one row per goal. Archiving or merging hides a goal from
 *   the picker and keeps the row, so cases written toward it still resolve.
 *   `created_by` is not a foreign key: a goal outlives the member who wrote it.
 * - `member_plan_state`: one row per (user, org). Its goal is a real foreign
 *   key, so deleting a goal clears it.
 * - `plan_goal_cases`: one row per case chat. The case file is the agent's
 *   to rewrite, so the link to its goal lives here instead of in the file.
 *
 * Nothing is copied from `organization_settings.plan_objective`: the first
 * read of an org with no goals seeds one from it, so an org that keeps
 * editing the single goal until it turns goals on starts from its latest text.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("plan_goals")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("statement", "text", (col) => col.notNull())
    .addColumn("source_label", "text")
    .addColumn("source_quote", "text")
    .addColumn("created_by", "text", (col) => col.notNull())
    .addColumn("updated_by", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("archived_at", "timestamptz")
    .addColumn("merged_into_id", "text", (col) =>
      col.references("plan_goals.id").onDelete("set null"),
    )
    .addCheckConstraint(
      "plan_goals_statement_not_blank",
      sql`length(btrim(statement)) > 0`,
    )
    .execute();

  await db.schema
    .createIndex("plan_goals_org_open")
    .on("plan_goals")
    .columns(["organization_id", "created_at"])
    .where(sql.ref("archived_at"), "is", null)
    .execute();

  await db.schema
    .createIndex("plan_goals_merged_into")
    .on("plan_goals")
    .column("merged_into_id")
    .where("merged_into_id", "is not", null)
    .execute();

  await db.schema
    .createTable("member_plan_state")
    .addColumn("user_id", "text", (col) =>
      col.notNull().references("user.id").onDelete("cascade"),
    )
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("active_goal_id", "text", (col) =>
      col.references("plan_goals.id").onDelete("set null"),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint("member_plan_state_pkey", [
      "user_id",
      "organization_id",
    ])
    .execute();

  // Serves the org cascade and the per-goal usage count.
  await db.schema
    .createIndex("member_plan_state_org_goal")
    .on("member_plan_state")
    .columns(["organization_id", "active_goal_id"])
    .execute();

  await db.schema
    .createTable("plan_goal_cases")
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("thread_id", "text", (col) => col.notNull())
    .addColumn("goal_id", "text", (col) =>
      col.notNull().references("plan_goals.id").onDelete("cascade"),
    )
    .addColumn("user_id", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint("plan_goal_cases_pkey", [
      "organization_id",
      "thread_id",
    ])
    .execute();

  await db.schema
    .createIndex("plan_goal_cases_goal")
    .on("plan_goal_cases")
    .columns(["goal_id", "created_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("plan_goal_cases").ifExists().execute();
  await db.schema.dropTable("member_plan_state").ifExists().execute();
  await db.schema.dropTable("plan_goals").ifExists().execute();
}
