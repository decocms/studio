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

const forecastRow = (
  organizationId: string,
  connectionId: string,
  localDate: string,
  forecast: StoredOrderForecast,
) => ({
  organization_id: organizationId,
  connection_id: connectionId,
  local_date: localDate,
  hour: forecast.hour,
  orders: JSON.stringify(forecast.orders),
  revenue: JSON.stringify(forecast.revenue),
  orders_rest: forecast.rest.orders,
  revenue_rest: forecast.rest.revenue,
  ratios: JSON.stringify(forecast.ratios),
  computed_at: forecast.computedAt,
});

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

  /** Writes the store's forecast for `localDate`, replacing one of the same hour. */
  async upsertForecast(
    organizationId: string,
    connectionId: string,
    localDate: string,
    forecast: StoredOrderForecast,
  ): Promise<void> {
    await this.db
      .insertInto("order_monitor_forecasts")
      .values(forecastRow(organizationId, connectionId, localDate, forecast))
      .onConflict((oc) =>
        oc
          .columns(["organization_id", "connection_id", "local_date", "hour"])
          .doUpdateSet({
            orders: (eb) => eb.ref("excluded.orders"),
            revenue: (eb) => eb.ref("excluded.revenue"),
            orders_rest: (eb) => eb.ref("excluded.orders_rest"),
            revenue_rest: (eb) => eb.ref("excluded.revenue_rest"),
            ratios: (eb) => eb.ref("excluded.ratios"),
            computed_at: (eb) => eb.ref("excluded.computed_at"),
          }),
      )
      .execute();
  }

  /** Writes forecasts for past local dates, leaving any already stored for the same hour. */
  async insertMissingForecasts(
    organizationId: string,
    connectionId: string,
    rows: { localDate: string; forecast: StoredOrderForecast }[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.db
      .insertInto("order_monitor_forecasts")
      .values(
        rows.map((r) =>
          forecastRow(organizationId, connectionId, r.localDate, r.forecast),
        ),
      )
      .onConflict((oc) =>
        oc
          .columns(["organization_id", "connection_id", "local_date", "hour"])
          .doNothing(),
      )
      .execute();
  }

  /** The predicted rest of day stored for the store's `hour` on each of `localDates` that has one. */
  async predictedRests(
    organizationId: string,
    connectionId: string,
    hour: number,
    localDates: string[],
  ): Promise<Map<string, StoredOrderForecast["rest"]>> {
    if (localDates.length === 0) return new Map();
    const rows = await this.db
      .selectFrom("order_monitor_forecasts")
      .select(["local_date", "orders_rest", "revenue_rest"])
      .where("organization_id", "=", organizationId)
      .where("connection_id", "=", connectionId)
      .where("local_date", "in", localDates)
      .where("hour", "=", hour)
      .execute();
    return new Map(
      rows.map((r) => [
        r.local_date,
        { orders: r.orders_rest, revenue: r.revenue_rest },
      ]),
    );
  }

  /** The store's forecast from the latest hour of its local day; null when there is none or it doesn't parse. */
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
