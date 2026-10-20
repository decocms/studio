import { type Kysely, sql } from "kysely";
import type { Database } from "./types";

/** An ingest install: one store the order monitor watches. */
export interface MonitoredStore {
  organizationId: string;
  connectionId: string;
  /** Who installed it; the sweep reads the org's plan as this user. */
  createdBy: string;
}

export interface OrderMonitorStateRow {
  rule: string;
  status: string;
  since: Date;
  evaluatedAt: Date;
  verdict: Record<string, unknown>;
}

export interface StoredOrderMonitorState extends OrderMonitorStateRow {
  connectionId: string;
  task: { id: string; keySeq: number } | null;
}

/**
 * Order-monitor verdicts (migration 255). `listIngestInstalls` spans every org
 * and exists only for the sweep; the rest take the org in the WHERE clause.
 */
export class OrderMonitorStorage {
  constructor(private readonly db: Kysely<Database>) {}

  async listIngestInstalls(ingestUrl: string): Promise<MonitoredStore[]> {
    const rows = await this.db
      .selectFrom("connections")
      .select(["id", "organization_id", "created_by"])
      .where("connection_url", "=", ingestUrl)
      .where("status", "=", "active")
      .orderBy("id")
      .execute();
    return rows.map((r) => ({
      organizationId: r.organization_id,
      connectionId: r.id,
      createdBy: r.created_by,
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
      .selectFrom("order_monitor_state as s")
      .leftJoin("task_board_items as t", (join) =>
        join
          .onRef("t.id", "=", "s.task_board_item_id")
          .onRef("t.organization_id", "=", "s.organization_id"),
      )
      .select([
        "s.connection_id",
        "s.rule",
        "s.status",
        "s.since",
        "s.evaluated_at",
        "s.verdict",
        "t.id as task_id",
        "t.key_seq as task_key_seq",
      ])
      .where("s.organization_id", "=", organizationId);
    if (connectionId) query = query.where("s.connection_id", "=", connectionId);
    const rows = await query.execute();
    return rows.map((r) => ({
      connectionId: r.connection_id,
      rule: r.rule,
      status: r.status,
      since: r.since,
      evaluatedAt: r.evaluated_at,
      verdict: r.verdict,
      task:
        r.task_id && r.task_key_seq !== null
          ? { id: r.task_id, keySeq: r.task_key_seq }
          : null,
    }));
  }

  /** Writes the verdicts; the incident link is `setIncidentTask`'s. */
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
        })),
      )
      .onConflict((oc) =>
        oc.columns(["organization_id", "connection_id", "rule"]).doUpdateSet({
          status: (eb) => eb.ref("excluded.status"),
          since: (eb) => eb.ref("excluded.since"),
          evaluated_at: (eb) => eb.ref("excluded.evaluated_at"),
          verdict: (eb) => eb.ref("excluded.verdict"),
        }),
      )
      .execute();
  }

  async setIncidentTask(
    organizationId: string,
    connectionId: string,
    rule: string,
    taskBoardItemId: string | null,
  ): Promise<void> {
    await this.db
      .updateTable("order_monitor_state")
      .set({ task_board_item_id: taskBoardItemId })
      .where("organization_id", "=", organizationId)
      .where("connection_id", "=", connectionId)
      .where("rule", "=", rule)
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

  /** The org's owners and admins: who an incident card subscribes. */
  async listOrgAdmins(organizationId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom("member")
      .select(["userId", "role"])
      .where("organizationId", "=", organizationId)
      .execute();
    return rows
      .filter((m) =>
        m.role.split(",").some((r) => r === "owner" || r === "admin"),
      )
      .map((m) => m.userId);
  }

  /** Merges incident flags into the rule's verdict (`ingestIncident`, `crossCheckPending`). */
  async setVerdictFlags(
    organizationId: string,
    connectionId: string,
    rule: string,
    flags: Partial<Record<"ingestIncident" | "crossCheckPending", boolean>>,
  ): Promise<void> {
    await this.db
      .updateTable("order_monitor_state")
      .set({
        verdict: sql<string>`verdict || ${JSON.stringify(flags)}::jsonb`,
      })
      .where("organization_id", "=", organizationId)
      .where("connection_id", "=", connectionId)
      .where("rule", "=", rule)
      .execute();
  }
}
