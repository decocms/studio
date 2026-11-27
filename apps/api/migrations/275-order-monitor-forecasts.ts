import type { Kysely } from "kysely";

/**
 * The Monitor's model forecast per store and local hour, written by the
 * order-monitor sweep and read by the day view (monitoring/order-forecast.ts).
 * The sweep deletes rows after a few days.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("order_monitor_forecasts")
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("connection_id", "text", (col) =>
      col.notNull().references("connections.id").onDelete("cascade"),
    )
    // The store's local day (YYYY-MM-DD) and the clock hour the forecast starts at.
    .addColumn("local_date", "text", (col) => col.notNull())
    .addColumn("hour", "integer", (col) => col.notNull())
    // The model's median per clock hour from `hour` on.
    .addColumn("orders", "jsonb", (col) => col.notNull())
    .addColumn("revenue", "jsonb", (col) => col.notNull())
    // Per calibration day: its actual rest of day ÷ the model's forecast of it.
    .addColumn("ratios", "jsonb", (col) => col.notNull())
    .addColumn("computed_at", "timestamptz", (col) => col.notNull())
    .addPrimaryKeyConstraint("order_monitor_forecasts_pkey", [
      "organization_id",
      "connection_id",
      "local_date",
      "hour",
    ])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("order_monitor_forecasts").ifExists().execute();
}
