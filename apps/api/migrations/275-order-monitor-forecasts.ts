import { type Kysely, sql } from "kysely";

/**
 * The Monitor's model forecast per store and local hour, written by the
 * order-monitor sweep and read by the day view (monitoring/order-forecast.ts).
 * A row's predicted rest of day calibrates the store's forecasts at the same
 * hour for the next 28 days; the sweep deletes rows after 35. Every run leaves
 * a row, failed ones too, with what Grafana needs to chart the pipeline's
 * health and the model's live accuracy against the baseline projection.
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
    // 'live': the sweep's run for the hour; 'backfill': a past day forecast
    // later, as calibration for a store without its live forecast.
    .addColumn("source", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("error", "text")
    .addColumn("latency_ms", "integer")
    .addColumn("series_sent", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("backfilled_days", "integer", (col) =>
      col.notNull().defaultTo(0),
    )
    // The model's median per clock hour from `hour` on; null unless status is 'ok'.
    .addColumn("orders", "jsonb")
    .addColumn("revenue", "jsonb")
    // The median's total from `hour` on: what later runs calibrate against.
    .addColumn("orders_rest", "double precision")
    .addColumn("revenue_rest", "double precision")
    // Per calibration day: its actual rest of day ÷ the model's forecast of it.
    .addColumn("ratios", "jsonb")
    // Live rows, as of the sweep tick that asked for the forecast.
    .addColumn("so_far_orders", "double precision")
    .addColumn("so_far_revenue", "double precision")
    .addColumn("pred_close_orders", "double precision")
    .addColumn("pred_close_revenue", "double precision")
    .addColumn("band_lo_orders", "double precision")
    .addColumn("band_hi_orders", "double precision")
    .addColumn("band_lo_revenue", "double precision")
    .addColumn("band_hi_revenue", "double precision")
    .addColumn("baseline_close_orders", "double precision")
    .addColumn("baseline_close_revenue", "double precision")
    // The day's close, set once on every row of the day after it ends.
    .addColumn("actual_close_orders", "double precision")
    .addColumn("actual_close_revenue", "double precision")
    .addColumn("actual_is_outage", "boolean")
    .addColumn("computed_at", "timestamptz", (col) => col.notNull())
    .addPrimaryKeyConstraint("order_monitor_forecasts_pkey", [
      "organization_id",
      "connection_id",
      "local_date",
      "hour",
    ])
    .addCheckConstraint(
      "order_monitor_forecasts_source_check",
      sql`source IN ('live', 'backfill')`,
    )
    .addCheckConstraint(
      "order_monitor_forecasts_status_check",
      sql`status IN ('ok', 'failed', 'timeout')`,
    )
    .execute();
  await db.schema
    .createIndex("order_monitor_forecasts_computed_at_idx")
    .on("order_monitor_forecasts")
    .column("computed_at")
    .execute();
  await db.schema
    .createIndex("order_monitor_forecasts_local_date_hour_idx")
    .on("order_monitor_forecasts")
    .columns(["local_date", "hour"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("order_monitor_forecasts").ifExists().execute();
}
