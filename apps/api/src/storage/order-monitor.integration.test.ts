import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import {
  type ForecastRecord,
  OrderMonitorStorage,
  type StoredOrderForecast,
} from "./order-monitor";

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

  const forecast = (hour: number, computedAt: Date, value = 5) => ({
    hour,
    orders: new Array<number>(24 - hour).fill(value),
    revenue: new Array<number>(24 - hour).fill(value * 100.5),
    rest: { orders: (24 - hour) * value, revenue: (24 - hour) * value * 100.5 },
    ratios: [{ daysAgo: 1, orders: 1.25, revenue: 0.75 }],
    computedAt,
  });
  /** A live run that answered `f`. */
  const ok = (f: StoredOrderForecast): ForecastRecord => ({
    hour: f.hour,
    source: "live",
    status: "ok",
    forecast: f,
    computedAt: f.computedAt,
  });

  test("round-trips a store's forecast and reads the latest hour of its day", async () => {
    const t = new Date("2026-11-26T13:08:00Z");
    await storage.recordForecast(
      orgId,
      "conn_om_store",
      "2026-11-26",
      ok(forecast(9, t)),
    );
    await storage.recordForecast(
      orgId,
      "conn_om_store",
      "2026-11-26",
      ok(forecast(10, t)),
    );
    await storage.recordForecast(
      orgId,
      "conn_om_store",
      "2026-11-25",
      ok(forecast(23, t)),
    );
    expect(
      await storage.latestForecast(orgId, "conn_om_store", "2026-11-26"),
    ).toEqual(forecast(10, t));
    expect(
      await storage.latestForecast(orgId, "conn_om_store", "2026-11-24"),
    ).toBeNull();
    // Another org never reads it.
    expect(
      await storage.latestForecast(
        "org_elsewhere",
        "conn_om_store",
        "2026-11-26",
      ),
    ).toBeNull();
  });

  test("a re-run of the same store hour replaces its forecast", async () => {
    const t = new Date("2026-11-26T14:08:00Z");
    await storage.recordForecast(
      orgId,
      "conn_om_store",
      "2026-11-26",
      ok(forecast(11, t, 3)),
    );
    await storage.recordForecast(
      orgId,
      "conn_om_store",
      "2026-11-26",
      ok(forecast(11, new Date(t.getTime() + 60_000), 4)),
    );
    const rows = await database.db
      .selectFrom("order_monitor_forecasts")
      .select("hour")
      .where("connection_id", "=", "conn_om_store")
      .where("local_date", "=", "2026-11-26")
      .where("hour", "=", 11)
      .execute();
    expect(rows).toHaveLength(1);
    expect(
      await storage.latestForecast(orgId, "conn_om_store", "2026-11-26"),
    ).toEqual(forecast(11, new Date(t.getTime() + 60_000), 4));
  });

  test("reads the predicted rest stored at one hour by local date, and never overwrites a stored day with a backfill", async () => {
    const t = new Date("2026-11-26T15:08:00Z");
    await storage.recordForecast(
      orgId,
      "conn_om_store",
      "2026-11-21",
      ok(forecast(12, t, 2)),
    );
    await storage.insertMissingForecasts(orgId, "conn_om_store", [
      { localDate: "2026-11-21", record: ok(forecast(12, t, 9)) },
      {
        localDate: "2026-11-22",
        record: { ...ok(forecast(12, t, 3)), source: "backfill" },
      },
    ]);
    await storage.insertMissingForecasts(orgId, "conn_om_store", []);
    // Another hour of the same day isn't read.
    await storage.recordForecast(
      orgId,
      "conn_om_store",
      "2026-11-23",
      ok(forecast(13, t)),
    );
    const rests = await storage.predictedRests(orgId, "conn_om_store", 12, [
      "2026-11-21",
      "2026-11-22",
      "2026-11-23",
    ]);
    expect([...rests.entries()]).toEqual([
      ["2026-11-21", { orders: 24, revenue: 24 * 100.5 }],
      ["2026-11-22", { orders: 36, revenue: 36 * 100.5 }],
    ]);
    expect(
      (
        await storage.predictedRests("org_elsewhere", "conn_om_store", 12, [
          "2026-11-21",
        ])
      ).size,
    ).toBe(0);
    expect(
      (await storage.predictedRests(orgId, "conn_om_store", 12, [])).size,
    ).toBe(0);
  });

  test("a failed run leaves a row the day view and calibration don't use", async () => {
    const t = new Date("2026-11-27T13:08:00Z");
    await storage.recordForecast(
      orgId,
      "conn_om_store",
      "2026-11-27",
      ok(forecast(9, t)),
    );
    await storage.recordForecast(orgId, "conn_om_store", "2026-11-27", {
      hour: 10,
      source: "live",
      status: "timeout",
      error: "The operation timed out.",
      latencyMs: 60_000,
      seriesSent: 2,
      soFar: { orders: 30, revenue: 3000 },
      baselineClose: { orders: 90, revenue: 9000 },
      computedAt: t,
    });
    // The hour before still serves; the failed hour is skipped.
    expect(
      (await storage.latestForecast(orgId, "conn_om_store", "2026-11-27"))
        ?.hour,
    ).toBe(9);
    expect([
      ...(
        await storage.predictedRests(orgId, "conn_om_store", 10, ["2026-11-27"])
      ).entries(),
    ]).toEqual([["2026-11-27", null]]);
    const row = await database.db
      .selectFrom("order_monitor_forecasts")
      .selectAll()
      .where("connection_id", "=", "conn_om_store")
      .where("local_date", "=", "2026-11-27")
      .where("hour", "=", 10)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      source: "live",
      status: "timeout",
      error: "The operation timed out.",
      latency_ms: 60_000,
      series_sent: 2,
      backfilled_days: 0,
      orders: null,
      orders_rest: null,
      pred_close_orders: null,
      band_lo_orders: null,
      so_far_orders: 30,
      baseline_close_orders: 90,
      baseline_close_revenue: 9000,
      actual_close_orders: null,
    });
    // A re-run of the hour that answers replaces the failure.
    await storage.recordForecast(orgId, "conn_om_store", "2026-11-27", {
      ...ok(forecast(10, t)),
      latencyMs: 420,
      seriesSent: 2,
      soFar: { orders: 30, revenue: 3000 },
      predClose: { orders: 100, revenue: 10_000.5 },
      band: {
        lo: { orders: 80, revenue: 8000 },
        hi: { orders: 120, revenue: 12_000 },
      },
      baselineClose: { orders: 90, revenue: 9000 },
    });
    expect(
      await database.db
        .selectFrom("order_monitor_forecasts")
        .select([
          "status",
          "error",
          "latency_ms",
          "pred_close_orders",
          "pred_close_revenue",
          "band_lo_orders",
          "band_hi_revenue",
          "baseline_close_orders",
        ])
        .where("connection_id", "=", "conn_om_store")
        .where("local_date", "=", "2026-11-27")
        .where("hour", "=", 10)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      status: "ok",
      error: null,
      latency_ms: 420,
      pred_close_orders: 100,
      pred_close_revenue: 10_000.5,
      band_lo_orders: 80,
      band_hi_revenue: 12_000,
      baseline_close_orders: 90,
    });
  });

  test("sets a finished day's close once, on every row of the day", async () => {
    const t = new Date("2026-11-28T13:08:00Z");
    for (const hour of [9, 10]) {
      await storage.recordForecast(
        orgId,
        "conn_om_store",
        "2026-11-28",
        ok(forecast(hour, t)),
      );
    }
    expect(
      await storage.datesWithoutActuals(orgId, "conn_om_store", "2026-11-28"),
    ).not.toContain("2026-11-28");
    const pending = await storage.datesWithoutActuals(
      orgId,
      "conn_om_store",
      "2026-11-29",
    );
    expect(pending).toContain("2026-11-28");
    await storage.setActuals(orgId, "conn_om_store", "2026-11-28", {
      orders: 210,
      revenue: 21_000.25,
      outage: false,
    });
    // A later fill leaves it alone.
    await storage.setActuals(orgId, "conn_om_store", "2026-11-28", {
      orders: 1,
      revenue: 1,
      outage: true,
    });
    expect(
      await database.db
        .selectFrom("order_monitor_forecasts")
        .select([
          "hour",
          "actual_close_orders",
          "actual_close_revenue",
          "actual_is_outage",
        ])
        .where("connection_id", "=", "conn_om_store")
        .where("local_date", "=", "2026-11-28")
        .orderBy("hour")
        .execute(),
    ).toEqual([
      {
        hour: 9,
        actual_close_orders: 210,
        actual_close_revenue: 21_000.25,
        actual_is_outage: false,
      },
      {
        hour: 10,
        actual_close_orders: 210,
        actual_close_revenue: 21_000.25,
        actual_is_outage: false,
      },
    ]);
    expect(
      await storage.datesWithoutActuals(orgId, "conn_om_store", "2026-11-29"),
    ).not.toContain("2026-11-28");
    expect(
      await storage.datesWithoutActuals(
        "org_elsewhere",
        "conn_om_store",
        "2026-11-29",
      ),
    ).toEqual([]);
  });

  test("deletes only the listed orgs' forecasts for local dates before the cutoff", async () => {
    // Computed recently, for an old day: the local date decides.
    await storage.recordForecast(
      orgId,
      "conn_om_store",
      "2026-11-20",
      ok(forecast(7, new Date("2026-11-26T10:00:00Z"))),
    );
    const cutoff = "2026-11-21";
    await storage.deleteForecastsBefore(["org_elsewhere"], cutoff);
    await storage.deleteForecastsBefore([], cutoff);
    expect(
      await storage.latestForecast(orgId, "conn_om_store", "2026-11-20"),
    ).not.toBeNull();
    await storage.deleteForecastsBefore([orgId], cutoff);
    expect(
      await storage.latestForecast(orgId, "conn_om_store", "2026-11-20"),
    ).toBeNull();
    // Newer ones stay.
    expect(
      await storage.latestForecast(orgId, "conn_om_store", "2026-11-26"),
    ).not.toBeNull();
  });

  test("drops a store's state and forecasts with its connection", async () => {
    await database.db
      .deleteFrom("connections")
      .where("id", "=", "conn_om_store")
      .execute();
    expect(await storage.listStates(orgId, "conn_om_store")).toEqual([]);
    expect(
      await database.db
        .selectFrom("order_monitor_forecasts")
        .select("hour")
        .where("connection_id", "=", "conn_om_store")
        .execute(),
    ).toEqual([]);
  });
});
