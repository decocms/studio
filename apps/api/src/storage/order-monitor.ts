import type { Kysely } from "kysely";
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

/**
 * Order-monitor verdicts (migration 255). `listIngestInstalls` spans every org
 * and exists only for the sweep; the rest take the org in the WHERE clause.
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
