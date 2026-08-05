import { sql, type Kysely } from "kysely";

/**
 * Per-org task-execution allowances, overriding the deployment-wide
 * `STUDIO_FREE_TASKS` / `STUDIO_MONTHLY_TASKS` for one tenant.
 *
 * The env knobs are global, so today the only way to give a client POC a
 * bigger allowance is faking `organization_billing.status = 'active'` — which
 * still caps at the global monthly number and breaks Checkout ("already has an
 * active subscription") and the Customer Portal (no `stripe_customer_id`).
 *
 * COLUMNS, not `organization_settings.flags` entries: the flags bag is for
 * booleans (see the repo guidelines), and these are numbers. They live on
 * `organization_billing` because `claimTaskExecution` already loads that row
 * to pick the period bucket, so a per-org limit costs no extra query.
 *
 * One column per existing knob rather than a single blended number, so nothing
 * about the period buckets changes: an unsubscribed org still uses the lifetime
 * `trial` bucket and a subscribed one still uses its Stripe cycle — only the
 * ceiling differs.
 *
 * NULL = use the deployment default. The check constraints reject 0 and
 * negatives: "block this org entirely" is not what an allowance means, and 0
 * would be indistinguishable from unset to a careless reader.
 *
 * Deliberately NOT exposed through any MCP tool: an org admin must never be
 * able to raise their own limit. Setting these is an operator action.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_billing")
    .addColumn("free_task_executions", "integer", (col) =>
      col.check(sql`free_task_executions > 0`),
    )
    .addColumn("monthly_task_executions", "integer", (col) =>
      col.check(sql`monthly_task_executions > 0`),
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_billing")
    .dropColumn("free_task_executions")
    .dropColumn("monthly_task_executions")
    .execute();
}
