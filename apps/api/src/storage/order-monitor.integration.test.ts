import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import { OrderMonitorStorage } from "./order-monitor";

const INGEST_URL = "https://ingest.example.com/mcp";

describe("OrderMonitorStorage", () => {
  let database: StudioDatabase;
  let storage: OrderMonitorStorage;
  const orgId = "org_order_monitor_test";
  const userId = "user_order_monitor_test";

  async function insertConnection(
    id: string,
    url: string,
    status: "active" | "inactive",
  ) {
    const now = new Date().toISOString();
    await database.db
      .insertInto("connections")
      .values({
        id,
        organization_id: orgId,
        created_by: userId,
        updated_by: null,
        title: id,
        description: null,
        icon: null,
        app_name: null,
        app_id: null,
        slug: null,
        connection_type: "HTTP",
        connection_url: url,
        connection_token: null,
        connection_headers: null,
        oauth_config: null,
        configuration_state: null,
        configuration_scopes: null,
        metadata: null,
        bindings: null,
        status,
        pinned: false,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    storage = new OrderMonitorStorage(database.db);
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "organization" (id, name, slug, "createdAt")
      VALUES (${orgId}, ${orgId}, ${orgId}, ${now})
    `.execute(database.db);
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${userId}, ${`${userId}@example.com`}, false, 'Order monitor', ${now}, ${now})
    `.execute(database.db);
    await insertConnection("conn_om_store", INGEST_URL, "active");
    await insertConnection("conn_om_paused", INGEST_URL, "inactive");
    await insertConnection(
      "conn_om_other",
      "https://other.example.com/mcp",
      "active",
    );
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  test("lists only active installs of the ingest URL", async () => {
    expect(await storage.listIngestInstalls(INGEST_URL)).toEqual([
      {
        organizationId: orgId,
        connectionId: "conn_om_store",
        createdBy: userId,
        title: "conn_om_store",
        orgSlug: orgId,
      },
    ]);
  });

  test("upserts one row per rule and replaces it on the next tick", async () => {
    const t1 = new Date("2026-10-19T17:03:00Z");
    const t2 = new Date("2026-10-19T17:08:00Z");
    await storage.upsertStates(orgId, "conn_om_store", [
      {
        rule: "orders_drop",
        status: "ok",
        since: t1,
        evaluatedAt: t1,
        verdict: { observed: 40 },
      },
      {
        rule: "cancel_spike",
        status: "low-volume",
        since: t1,
        evaluatedAt: t1,
        verdict: {},
      },
    ]);
    await storage.upsertStates(orgId, "conn_om_store", [
      {
        rule: "orders_drop",
        status: "alert",
        since: t2,
        evaluatedAt: t2,
        verdict: { observed: 0 },
      },
    ]);
    const states = await storage.listStates(orgId, "conn_om_store");
    const byRule = Object.fromEntries(states.map((s) => [s.rule, s]));
    expect(states).toHaveLength(2);
    expect(byRule.orders_drop).toMatchObject({
      status: "alert",
      since: t2,
      evaluatedAt: t2,
      verdict: { observed: 0 },
    });
    expect(byRule.cancel_spike?.evaluatedAt).toEqual(t1);
    expect(await storage.listStates("org_elsewhere", "conn_om_store")).toEqual(
      [],
    );
  });

  test("finds the store's agents and their repositories", async () => {
    const now = new Date().toISOString();
    await insertConnection(
      "conn_om_vtex",
      "https://vtex.example.com/mcp",
      "active",
    );
    await insertConnection(
      "conn_om_agent",
      "virtual://conn_om_agent",
      "active",
    );
    await database.db
      .updateTable("connections")
      .set({ connection_type: "VIRTUAL" })
      .where("id", "=", "conn_om_agent")
      .execute();
    await database.db
      .insertInto("connection_aggregations")
      .values({
        id: "agg_om_1",
        parent_connection_id: "conn_om_agent",
        child_connection_id: "conn_om_vtex",
        selected_tools: null,
        selected_resources: null,
        selected_prompts: null,
        dependency_mode: "direct",
        created_at: now,
      })
      .execute();
    expect(
      await storage.listAggregatingAgents(orgId, ["conn_om_vtex"]),
    ).toEqual([{ agentId: "conn_om_agent", childId: "conn_om_vtex" }]);
    expect(
      await storage.listAggregatingAgents("org_elsewhere", ["conn_om_vtex"]),
    ).toEqual([]);
    expect(await storage.listAgentRepositoryIds(orgId)).toEqual([]);
  });

  test("drops a store's state with its connection", async () => {
    await database.db
      .deleteFrom("connections")
      .where("id", "=", "conn_om_store")
      .execute();
    expect(await storage.listStates(orgId, "conn_om_store")).toEqual([]);
  });
});
