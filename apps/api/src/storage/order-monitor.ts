import type { Kysely } from "kysely";
import { z } from "zod";
import type { Database } from "./types";

/** An ingest install: one store the order monitor watches. */
export interface MonitoredStore {
  organizationId: string;
  connectionId: string;
  /** Who installed it; the sweep reads the org's plan as this user. */
  createdBy: string;
  /** The install's title, which names the store in an alert. */
  title: string;
  /** For the alert's link to the store's chart. */
  orgSlug: string;
}

export interface OrderMonitorStateRow {
  rule: string;
  status: string;
  since: Date;
  evaluatedAt: Date;
  verdict: Record<string, unknown>;
  /** The status this row's tick replaced. */
  prevStatus?: string | null;
}

export interface StoredOrderMonitorState extends OrderMonitorStateRow {
  connectionId: string;
}

const ForecastRowSchema = z.object({
  hour: z.number().int().min(0).max(23),
  orders: z.array(z.number()),
  revenue: z.array(z.number()),
  /** The median's total from `hour` on. */
  rest: z.object({ orders: z.number(), revenue: z.number() }),
  ratios: z.array(
    z.object({ daysAgo: z.number(), orders: z.number(), revenue: z.number() }),
  ),
});

/** The model's forecast for a store's local day from `hour` on (migration 275). */
export interface StoredOrderForecast extends z.infer<typeof ForecastRowSchema> {
  computedAt: Date;
}

type Pair = { orders: number; revenue: number };

/** One forecast run's row: the forecast when it answered, and how the run went. */
export interface ForecastRecord {
  hour: number;
  source: "live" | "backfill";
  status: "ok" | "failed" | "timeout";
  error?: string | null;
  latencyMs?: number | null;
  seriesSent?: number;
  backfilledDays?: number;
  forecast?: Omit<StoredOrderForecast, "hour" | "computedAt"> | null;
  /** As of the sweep tick that asked for a live forecast. */
  soFar?: Pair | null;
  predClose?: Pair | null;
  band?: { lo: Pair; hi: Pair } | null;
  baselineClose?: Pair | null;
  computedAt: Date;
}

const recordRow = (
  organizationId: string,
  connectionId: string,
  localDate: string,
  r: ForecastRecord,
) => ({
  organization_id: organizationId,
  connection_id: connectionId,
  local_date: localDate,
  hour: r.hour,
  source: r.source,
  status: r.status,
  error: r.error ?? null,
  latency_ms: r.latencyMs ?? null,
  series_sent: r.seriesSent ?? 0,
  backfilled_days: r.backfilledDays ?? 0,
  orders: r.forecast ? JSON.stringify(r.forecast.orders) : null,
  revenue: r.forecast ? JSON.stringify(r.forecast.revenue) : null,
  orders_rest: r.forecast?.rest.orders ?? null,
  revenue_rest: r.forecast?.rest.revenue ?? null,
  ratios: r.forecast ? JSON.stringify(r.forecast.ratios) : null,
  so_far_orders: r.soFar?.orders ?? null,
  so_far_revenue: r.soFar?.revenue ?? null,
  pred_close_orders: r.predClose?.orders ?? null,
  pred_close_revenue: r.predClose?.revenue ?? null,
  band_lo_orders: r.band?.lo.orders ?? null,
  band_hi_orders: r.band?.hi.orders ?? null,
  band_lo_revenue: r.band?.lo.revenue ?? null,
  band_hi_revenue: r.band?.hi.revenue ?? null,
  baseline_close_orders: r.baselineClose?.orders ?? null,
  baseline_close_revenue: r.baselineClose?.revenue ?? null,
  computed_at: r.computedAt,
});

/** Every column a re-run of the same store hour replaces. */
const RERUN_COLUMNS = [
  "source",
  "status",
  "error",
  "latency_ms",
  "series_sent",
  "backfilled_days",
  "orders",
  "revenue",
  "orders_rest",
  "revenue_rest",
  "ratios",
  "so_far_orders",
  "so_far_revenue",
  "pred_close_orders",
  "pred_close_revenue",
  "band_lo_orders",
  "band_hi_orders",
  "band_lo_revenue",
  "band_hi_revenue",
  "baseline_close_orders",
  "baseline_close_revenue",
  "computed_at",
] as const;

/**
 * Order-monitor verdicts (migration 255) and model forecasts (migration 275).
 * `listIngestInstalls` spans every org and exists only for the sweep; the rest
 * take the org in the WHERE clause.
 */
export class OrderMonitorStorage {
  constructor(private readonly db: Kysely<Database>) {}

  async listIngestInstalls(ingestUrl: string): Promise<MonitoredStore[]> {
    const rows = await this.db
      .selectFrom("connections as c")
      .innerJoin("organization as o", "o.id", "c.organization_id")
      .select([
        "c.id",
        "c.organization_id",
        "c.created_by",
        "c.title",
        "o.slug",
      ])
      .where("c.connection_url", "=", ingestUrl)
      .where("c.status", "=", "active")
      .orderBy("c.id")
      .execute();
    return rows.map((r) => ({
      organizationId: r.organization_id,
      connectionId: r.id,
      createdBy: r.created_by,
      title: r.title,
      orgSlug: r.slug,
    }));
  }

  /** The orgs with an active ingest install, by name: what an admin org can look into. */
  async listMonitoredOrgs(
    ingestUrl: string,
  ): Promise<{ id: string; slug: string; name: string }[]> {
    return this.db
      .selectFrom("connections as c")
      .innerJoin("organization as o", "o.id", "c.organization_id")
      .select(["o.id", "o.slug", "o.name"])
      .where("c.connection_url", "=", ingestUrl)
      .where("c.status", "=", "active")
      .distinct()
      .orderBy("o.name")
      .execute();
  }

  /** The org an active ingest install belongs to; null when it isn't one. */
  async findInstallOrg(
    connectionId: string,
    ingestUrl: string,
  ): Promise<string | null> {
    const row = await this.db
      .selectFrom("connections")
      .select("organization_id")
      .where("id", "=", connectionId)
      .where("connection_url", "=", ingestUrl)
      .where("status", "=", "active")
      .executeTakeFirst();
    return row?.organization_id ?? null;
  }

  /** The org's active ingest installs, by title. */
  async listOrgStores(
    organizationId: string,
    ingestUrl: string,
  ): Promise<{ connectionId: string; title: string }[]> {
    const rows = await this.db
      .selectFrom("connections")
      .select(["id", "title"])
      .where("organization_id", "=", organizationId)
      .where("connection_url", "=", ingestUrl)
      .where("status", "=", "active")
      .orderBy("title")
      .execute();
    return rows.map((r) => ({ connectionId: r.id, title: r.title }));
  }

  /** Every state row of the org, or of one store when `connectionId` is set. */
  async listStates(
    organizationId: string,
    connectionId?: string,
  ): Promise<StoredOrderMonitorState[]> {
    let query = this.db
      .selectFrom("order_monitor_state")
      .select([
        "connection_id",
        "rule",
        "status",
        "since",
        "evaluated_at",
        "verdict",
        "prev_status",
      ])
      .where("organization_id", "=", organizationId);
    if (connectionId) query = query.where("connection_id", "=", connectionId);
    const rows = await query.execute();
    return rows.map((r) => ({
      connectionId: r.connection_id,
      rule: r.rule,
      status: r.status,
      since: r.since,
      evaluatedAt: r.evaluated_at,
      verdict: r.verdict,
      prevStatus: r.prev_status,
    }));
  }

  /** Writes the verdicts. */
  async upsertStates(
    organizationId: string,
    connectionId: string,
    states: OrderMonitorStateRow[],
  ): Promise<void> {
    if (states.length === 0) return;
    await this.db
      .insertInto("order_monitor_state")
      .values(
        states.map((s) => ({
          organization_id: organizationId,
          connection_id: connectionId,
          rule: s.rule,
          status: s.status,
          since: s.since,
          evaluated_at: s.evaluatedAt,
          verdict: JSON.stringify(s.verdict),
          prev_status: s.prevStatus ?? null,
        })),
      )
      .onConflict((oc) =>
        oc.columns(["organization_id", "connection_id", "rule"]).doUpdateSet({
          status: (eb) => eb.ref("excluded.status"),
          since: (eb) => eb.ref("excluded.since"),
          evaluated_at: (eb) => eb.ref("excluded.evaluated_at"),
          verdict: (eb) => eb.ref("excluded.verdict"),
          prev_status: (eb) => eb.ref("excluded.prev_status"),
        }),
      )
      .execute();
  }

  /** Writes the run for the store's `localDate` and hour, replacing an earlier run of it. */
  async recordForecast(
    organizationId: string,
    connectionId: string,
    localDate: string,
    record: ForecastRecord,
  ): Promise<void> {
    await this.db
      .insertInto("order_monitor_forecasts")
      .values(recordRow(organizationId, connectionId, localDate, record))
      .onConflict((oc) =>
        oc
          .columns(["organization_id", "connection_id", "local_date", "hour"])
          .doUpdateSet((eb) =>
            Object.fromEntries(
              RERUN_COLUMNS.map((c) => [c, eb.ref(`excluded.${c}`)]),
            ),
          ),
      )
      .execute();
  }

  /** Writes rows for past local dates, leaving any row already there for the same hour. */
  async insertMissingForecasts(
    organizationId: string,
    connectionId: string,
    rows: { localDate: string; record: ForecastRecord }[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.db
      .insertInto("order_monitor_forecasts")
      .values(
        rows.map((r) =>
          recordRow(organizationId, connectionId, r.localDate, r.record),
        ),
      )
      .onConflict((oc) =>
        oc
          .columns(["organization_id", "connection_id", "local_date", "hour"])
          .doNothing(),
      )
      .execute();
  }

  /**
   * The predicted rest of day stored for the store's `hour` on each of
   * `localDates` that has a row: null when that run didn't answer.
   */
  async predictedRests(
    organizationId: string,
    connectionId: string,
    hour: number,
    localDates: string[],
  ): Promise<Map<string, StoredOrderForecast["rest"] | null>> {
    if (localDates.length === 0) return new Map();
    const rows = await this.db
      .selectFrom("order_monitor_forecasts")
      .select(["local_date", "status", "orders_rest", "revenue_rest"])
      .where("organization_id", "=", organizationId)
      .where("connection_id", "=", connectionId)
      .where("local_date", "in", localDates)
      .where("hour", "=", hour)
      .execute();
    return new Map(
      rows.map((r) => [
        r.local_date,
        r.status === "ok" && r.orders_rest !== null && r.revenue_rest !== null
          ? { orders: r.orders_rest, revenue: r.revenue_rest }
          : null,
      ]),
    );
  }

  /** The store's answered forecast from the latest hour of its local day; null when there is none or it doesn't parse. */
  async latestForecast(
    organizationId: string,
    connectionId: string,
    localDate: string,
  ): Promise<StoredOrderForecast | null> {
    const row = await this.db
      .selectFrom("order_monitor_forecasts")
      .select([
        "hour",
        "orders",
        "revenue",
        "orders_rest",
        "revenue_rest",
        "ratios",
        "computed_at",
      ])
      .where("organization_id", "=", organizationId)
      .where("connection_id", "=", connectionId)
      .where("local_date", "=", localDate)
      .where("status", "=", "ok")
      .orderBy("hour", "desc")
      .limit(1)
      .executeTakeFirst();
    const parsed = ForecastRowSchema.safeParse(
      row && {
        ...row,
        rest: { orders: row.orders_rest, revenue: row.revenue_rest },
      },
    );
    return row && parsed.success
      ? { ...parsed.data, computedAt: row.computed_at }
      : null;
  }

  /** The store's local dates before `localDate` that have rows without the day's close yet. */
  async datesWithoutActuals(
    organizationId: string,
    connectionId: string,
    localDate: string,
  ): Promise<string[]> {
    const rows = await this.db
      .selectFrom("order_monitor_forecasts")
      .select("local_date")
      .distinct()
      .where("organization_id", "=", organizationId)
      .where("connection_id", "=", connectionId)
      .where("local_date", "<", localDate)
      .where("actual_close_orders", "is", null)
      .execute();
    return rows.map((r) => r.local_date);
  }

  /** Sets the day's close on the store's rows of `localDate` that don't have one yet. */
  async setActuals(
    organizationId: string,
    connectionId: string,
    localDate: string,
    actual: { orders: number; revenue: number; outage: boolean },
  ): Promise<void> {
    await this.db
      .updateTable("order_monitor_forecasts")
      .set({
        actual_close_orders: actual.orders,
        actual_close_revenue: actual.revenue,
        actual_is_outage: actual.outage,
      })
      .where("organization_id", "=", organizationId)
      .where("connection_id", "=", connectionId)
      .where("local_date", "=", localDate)
      .where("actual_close_orders", "is", null)
      .execute();
  }

  /** Deletes the orgs' forecasts for local dates before `localDate` (YYYY-MM-DD). */
  async deleteForecastsBefore(
    organizationIds: string[],
    localDate: string,
  ): Promise<void> {
    if (organizationIds.length === 0) return;
    await this.db
      .deleteFrom("order_monitor_forecasts")
      .where("organization_id", "in", organizationIds)
      .where("local_date", "<", localDate)
      .execute();
  }

  /** Agents (VIRTUAL connections) that aggregate any of `connectionIds`. */
  async listAggregatingAgents(
    organizationId: string,
    connectionIds: string[],
  ): Promise<{ agentId: string; childId: string }[]> {
    if (connectionIds.length === 0) return [];
    const rows = await this.db
      .selectFrom("connection_aggregations as a")
      .innerJoin("connections as p", "p.id", "a.parent_connection_id")
      .select(["a.parent_connection_id", "a.child_connection_id"])
      .where("p.organization_id", "=", organizationId)
      .where("p.connection_type", "=", "VIRTUAL")
      .where("p.status", "=", "active")
      .where("a.child_connection_id", "in", connectionIds)
      .orderBy("p.created_at")
      .execute();
    return rows.map((r) => ({
      agentId: r.parent_connection_id,
      childId: r.child_connection_id,
    }));
  }

  /** The repositories the org's agents work in, or one agent's. */
  async listAgentRepositoryIds(
    organizationId: string,
    agentId?: string,
  ): Promise<string[]> {
    let query = this.db
      .selectFrom("connections")
      .select("repository_id")
      .distinct()
      .where("organization_id", "=", organizationId)
      .where("connection_type", "=", "VIRTUAL")
      .where("repository_id", "is not", null);
    if (agentId) query = query.where("id", "=", agentId);
    const rows = await query.execute();
    return rows.flatMap((r) => (r.repository_id ? [r.repository_id] : []));
  }
}
