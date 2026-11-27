import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "@/database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "@/database/test-db-pg";
import { setGlobalSettings } from "@/settings";
import { resolveConfig } from "@/settings/resolve-config";
import { AlertStorage } from "@/storage/alerts";
import {
  type MonitoredStore,
  OrderMonitorStorage,
} from "@/storage/order-monitor";
import {
  forecastOneStore,
  planForecasts,
  writeStates,
} from "./dbos-order-monitor";
import { BACKFILL_DAYS_PER_RUN, type ForecastJob } from "./order-forecast";
import { HISTORY_DAYS, type HourlyDay } from "./order-lake";
import type { Rule, Verdict } from "./order-rules";

const ORG = "org_sweep_alerts";
const USER = "user_sweep_alerts";
const STORE: MonitoredStore = {
  organizationId: ORG,
  connectionId: "conn_sweep_store",
  createdBy: USER,
  title: "Test Store",
  orgSlug: "sweep-org",
};

const verdict = (status: Verdict["status"], observed = 4): Verdict => ({
  status,
  from: 56,
  to: 60,
  observed,
  expected: 40,
  warnAt: 12,
  alertAt: 6,
  level: 1,
});
const tick = (drop: Verdict["status"]): Record<Rule, Verdict> => ({
  orders_drop: verdict(drop),
  denied_spike: verdict("low-volume"),
  cancel_spike: verdict("low-volume"),
});
const minute = (m: number) => new Date(Date.UTC(2026, 9, 19, 18, m));

async function insertStore(
  database: StudioDatabase,
  store: MonitoredStore,
  userId: string,
) {
  const now = new Date().toISOString();
  const org = store.organizationId;
  await sql`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (${org}, ${org}, ${store.orgSlug}, ${now}) ON CONFLICT DO NOTHING`.execute(
    database.db,
  );
  await sql`INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt") VALUES (${userId}, ${`${userId}@example.com`}, false, 'Sweep', ${now}, ${now}) ON CONFLICT DO NOTHING`.execute(
    database.db,
  );
  await database.db
    .insertInto("connections")
    .values({
      id: store.connectionId,
      organization_id: org,
      created_by: userId,
      updated_by: null,
      title: store.title,
      description: null,
      icon: null,
      app_name: null,
      app_id: null,
      slug: null,
      connection_type: "HTTP",
      connection_url: "https://ingest.example.com/mcp",
      connection_token: null,
      connection_headers: null,
      oauth_config: null,
      configuration_state: null,
      configuration_scopes: null,
      metadata: null,
      bindings: null,
      status: "active",
      pinned: false,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

describe("writeStates opens an alert when a rule crosses into alert", () => {
  let database: StudioDatabase;
  let alerts: AlertStorage;
  const write = (at: Date, drop: Verdict["status"]) =>
    writeStates(database.db, STORE, at, tick(drop), "America/Sao_Paulo");

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    alerts = new AlertStorage(database.db);
    await insertStore(database, STORE, USER);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  test("ok and warning open nothing", async () => {
    expect((await write(minute(3), "ok"))?.opened).toEqual([]);
    expect((await write(minute(8), "warning"))?.opened).toEqual([]);
    expect((await alerts.list(ORG)).alerts).toEqual([]);
  });

  test("the crossing opens one alert, and a re-run of that tick keeps it one", async () => {
    const first = await write(minute(13), "alert");
    expect(first?.opened).toHaveLength(1);
    const rerun = await write(minute(13), "alert");
    expect(rerun?.opened).toEqual([]);

    const open = (await alerts.list(ORG)).alerts;
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      id: first!.opened[0],
      source: "order_monitor",
      subjectId: STORE.connectionId,
      rule: "orders_drop",
      title: "Orders at Test Store are 90 % below expected since 14:00",
      body: "Orders: 4 between 14:00 and 15:00 vs 40 expected.",
      createdAt: minute(13).toISOString(),
    });
    expect(open[0]!.link).toStartWith(
      "/sweep-org/settings/monitor?tab=stores&store=conn_sweep_store&at=",
    );
  });

  test("staying in alert opens nothing, acked or not", async () => {
    expect((await write(minute(18), "alert"))?.opened).toEqual([]);
    const [open] = (await alerts.list(ORG)).alerts;
    await alerts.ack(ORG, open!.id, USER);
    expect((await write(minute(23), "alert"))?.opened).toEqual([]);
    expect((await alerts.list(ORG)).alerts).toEqual([]);
  });

  test("after the ack, the next crossing opens a new alert", async () => {
    await write(minute(28), "ok");
    const again = await write(minute(33), "alert");
    expect(again?.opened).toHaveLength(1);
    expect((await alerts.list(ORG)).alerts.map((a) => a.id)).toEqual(
      again!.opened,
    );
  });

  test("an older tick that lost the race writes nothing and opens nothing", async () => {
    await write(minute(38), "ok");
    expect(await write(minute(36), "alert")).toBeNull();
    expect((await alerts.list(ORG)).alerts).toHaveLength(1);
  });
});

describe("the sweep's model forecast", () => {
  let database: StudioDatabase;
  let storage: OrderMonitorStorage;
  const USER_F = "user_sweep_forecast";
  const on: MonitoredStore = {
    organizationId: "org_forecast_on",
    connectionId: "conn_forecast_on",
    createdBy: USER_F,
    title: "On",
    orgSlug: "forecast-on",
  };
  const other: MonitoredStore = {
    ...on,
    organizationId: "org_forecast_other",
    connectionId: "conn_forecast_other",
    orgSlug: "forecast-other",
  };
  // 10:08 in São Paulo: hour 10 under way.
  const at = new Date("2026-11-26T13:08:00Z");
  // As of the tick: 40 orders in, 2 of them in hour 10.
  const tickState = {
    soFar: { orders: 40, revenue: 4000 },
    inHour: { orders: 2, revenue: 200 },
    baselineClose: { orders: 100, revenue: 10_000 },
  };
  const read = {
    timezone: "America/Sao_Paulo",
    done: 40,
    backfill: [],
    ...tickState,
  };
  const swept = [
    {
      organizationId: on.organizationId,
      connectionId: on.connectionId,
      day: read,
    },
    {
      organizationId: other.organizationId,
      connectionId: other.connectionId,
      day: read,
    },
    // A store whose day the sweep couldn't read.
    { organizationId: other.organizationId, connectionId: "conn_unread" },
  ];
  const history = (): HourlyDay[] =>
    Array.from({ length: HISTORY_DAYS + 1 }, () => ({
      orders: new Array<number>(24).fill(10),
      revenue: new Array<number>(24).fill(1000),
    }));

  // A stand-in forecasting service: every series' horizon at `value`, or a 500.
  let failing = false;
  let value = 4;
  let calls = 0;
  let sent = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      calls++;
      const body = (await req.json()) as { series: unknown[]; horizon: number };
      sent = body.series.length;
      if (failing) return new Response("boom", { status: 500 });
      return Response.json({
        quantiles: {
          "0.5": body.series.map(() => new Array(body.horizon).fill(value)),
        },
      });
    },
  });
  const service = (path: string) => ({
    url: `${server.url.href}${path}`,
    cooldownMs: 0,
  });

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    storage = new OrderMonitorStorage(database.db);
    await insertStore(database, on, USER_F);
    await insertStore(database, other, USER_F);
  });

  afterAll(async () => {
    setGlobalSettings(resolveConfig(process.env));
    server.stop(true);
    await closeTestPgDatabase(database);
  });

  test("plans one forecast per store the sweep read, in every org, none without the service", async () => {
    setGlobalSettings(resolveConfig({ TIMESTRAL_URL: server.url.href }));
    const jobs = await planForecasts(database.db, swept, at);
    const due = (store: MonitoredStore) => ({
      organizationId: store.organizationId,
      connectionId: store.connectionId,
      timezone: "America/Sao_Paulo",
      at: at.toISOString(),
      date: "2026-11-26",
      hour: 10,
      backfill: [],
      ...tickState,
    });
    expect(jobs).toEqual([due(on), due(other)]);
    setGlobalSettings(resolveConfig({}));
    expect(await planForecasts(database.db, swept, at)).toEqual([]);
  });

  test("keeps 35 local days of forecasts and clears older ones on every tick", async () => {
    setGlobalSettings(resolveConfig({}));
    const row = {
      hour: 9,
      orders: new Array<number>(15).fill(1),
      revenue: new Array<number>(15).fill(1),
      rest: { orders: 15, revenue: 15 },
      ratios: [],
      computedAt: at,
    };
    // 2026-11-26 is the tick's date: 35 days back is 2026-10-22.
    for (const date of ["2026-10-20", "2026-10-22", "2026-11-23"]) {
      await storage.recordForecast(on.organizationId, on.connectionId, date, {
        hour: row.hour,
        source: "live",
        status: "ok",
        forecast: row,
        computedAt: row.computedAt,
      });
    }
    await planForecasts(database.db, swept, at);
    const kept = await database.db
      .selectFrom("order_monitor_forecasts")
      .select("local_date")
      .where("organization_id", "=", on.organizationId)
      .orderBy("local_date")
      .execute();
    expect(kept.map((r) => r.local_date)).toEqual(["2026-10-22", "2026-11-23"]);
    await database.db
      .deleteFrom("order_monitor_forecasts")
      .where("organization_id", "=", on.organizationId)
      .execute();
  });

  const job = (): ForecastJob => ({
    organizationId: on.organizationId,
    connectionId: on.connectionId,
    timezone: "America/Sao_Paulo",
    at: new Date().toISOString(),
    date: "2026-11-26",
    hour: 10,
    backfill: [],
    ...tickState,
  });

  const storedAt10 = async () =>
    (
      await database.db
        .selectFrom("order_monitor_forecasts")
        .select(["local_date", "orders_rest"])
        .where("organization_id", "=", on.organizationId)
        .where("hour", "=", 10)
        .orderBy("local_date", "desc")
        .execute()
    ).map((r) => [r.local_date, r.orders_rest]);

  test("a new store backfills its calibration days over its first runs, then sends only today", async () => {
    failing = false;
    value = 4;
    const run = () =>
      forecastOneStore(database.db, service("ok"), job(), async () =>
        history(),
      );
    await run();
    expect(sent).toBe(2 + 2 * BACKFILL_DAYS_PER_RUN);
    const first = await storage.latestForecast(
      on.organizationId,
      on.connectionId,
      "2026-11-26",
    );
    expect(first?.hour).toBe(10);
    expect(first?.orders).toEqual(new Array(14).fill(4));
    expect(first?.rest).toEqual({ orders: 56, revenue: 56 });
    // Each backfilled day brought 14 × 10 orders against 14 × 4 forecast.
    expect(first?.ratios).toHaveLength(BACKFILL_DAYS_PER_RUN);
    expect(first?.ratios[0]).toEqual({
      daysAgo: 1,
      orders: 140 / 56,
      revenue: 14_000 / 56,
    });
    expect((await storedAt10()).slice(0, 3)).toEqual([
      ["2026-11-26", 56],
      ["2026-11-25", 56],
      ["2026-11-24", 56],
    ]);
    expect(await storedAt10()).toHaveLength(1 + BACKFILL_DAYS_PER_RUN);

    // The next run backfills the rest; stored days keep what they hold.
    value = 5;
    await run();
    expect(sent).toBe(2 + 2 * (28 - BACKFILL_DAYS_PER_RUN));
    const stored = await storedAt10();
    expect(stored).toHaveLength(1 + 28);
    expect(stored[0]).toEqual(["2026-11-26", 70]);
    expect(stored[1]).toEqual(["2026-11-25", 56]);
    expect(stored.at(-1)).toEqual(["2026-10-29", 70]);
    const second = await storage.latestForecast(
      on.organizationId,
      on.connectionId,
      "2026-11-26",
    );
    expect(second?.ratios).toHaveLength(28);
    expect(second?.ratios[0]?.orders).toBe(140 / 56);
    expect(second?.ratios.at(-1)?.orders).toBe(140 / 70);

    // Steady state: every calibration day is stored, only today is sent.
    await run();
    expect(sent).toBe(2);
    expect(await storedAt10()).toHaveLength(1 + 28);
    // A re-run of the store hour replaces its row in place.
    const rows = await database.db
      .selectFrom("order_monitor_forecasts")
      .select(["hour", "orders"])
      .where("organization_id", "=", on.organizationId)
      .where("local_date", "=", "2026-11-26")
      .execute();
    expect(rows).toEqual([{ hour: 10, orders: new Array(14).fill(5) }]);
  });

  test("records the tick's so-far, baseline, predicted close and band on the live row", async () => {
    const row = await database.db
      .selectFrom("order_monitor_forecasts")
      .selectAll()
      .where("organization_id", "=", on.organizationId)
      .where("local_date", "=", "2026-11-26")
      .where("hour", "=", 10)
      .executeTakeFirstOrThrow();
    // The last run: value 5 per hour; 2 of hour 10's 5 were in at the tick.
    const close = 40 + 3 + 13 * 5;
    expect(row).toMatchObject({
      source: "live",
      status: "ok",
      error: null,
      series_sent: 2,
      backfilled_days: 0,
      so_far_orders: 40,
      so_far_revenue: 4000,
      pred_close_orders: close,
      pred_close_revenue: 4000 + 13 * 5,
      baseline_close_orders: 100,
      baseline_close_revenue: 10_000,
    });
    expect(row.latency_ms).toBeGreaterThanOrEqual(0);
    // Ratios: 140 ÷ 56 for the first 14 days, 140 ÷ 70 for the rest.
    expect(row.band_lo_orders).toBeCloseTo(40 + (close - 40) * 2);
    expect(row.band_hi_orders).toBeCloseTo(40 + (close - 40) * 2.5);
    const backfilled = await database.db
      .selectFrom("order_monitor_forecasts")
      .select(["source", "status", "latency_ms", "pred_close_orders"])
      .where("organization_id", "=", on.organizationId)
      .where("local_date", "=", "2026-11-25")
      .executeTakeFirstOrThrow();
    expect(backfilled).toEqual({
      source: "backfill",
      status: "ok",
      latency_ms: null,
      pred_close_orders: null,
    });
  });

  test("sets the close of the store's finished days once, flagging outage days", async () => {
    const closes = async (date: string) =>
      await database.db
        .selectFrom("order_monitor_forecasts")
        .select(["actual_close_orders", "actual_is_outage"])
        .where("organization_id", "=", on.organizationId)
        .where("local_date", "=", date)
        .where("hour", "=", 10)
        .execute();
    // Every finished day so far got its close: 24 × 10 orders.
    expect(await closes("2026-11-25")).toEqual([
      { actual_close_orders: 240, actual_is_outage: false },
    ]);
    expect(await closes("2026-10-29")).toEqual([
      { actual_close_orders: 240, actual_is_outage: false },
    ]);
    // Today isn't finished.
    expect(await closes("2026-11-26")).toEqual([
      { actual_close_orders: null, actual_is_outage: null },
    ]);
    // The next day's first run closes today; day 1 there is an outage.
    failing = false;
    value = 4;
    await forecastOneStore(
      database.db,
      service("ok"),
      { ...job(), date: "2026-11-27", hour: 0 },
      async () =>
        history().map((d, i) =>
          i === 1 ? { orders: d.orders.map(() => 1), revenue: d.revenue } : d,
        ),
    );
    expect(await closes("2026-11-26")).toEqual([
      { actual_close_orders: 24, actual_is_outage: true },
    ]);
    // Already set: a later run with other numbers leaves them.
    await forecastOneStore(
      database.db,
      service("ok"),
      { ...job(), date: "2026-11-27", hour: 1 },
      async () => history(),
    );
    expect(await closes("2026-11-26")).toEqual([
      { actual_close_orders: 24, actual_is_outage: true },
    ]);
    expect(await closes("2026-11-25")).toEqual([
      { actual_close_orders: 240, actual_is_outage: false },
    ]);
  });

  test("a failed forecast records its row, which the day view skips, and leaves the verdicts alone", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const verdicts = await writeStates(
        database.db,
        on,
        at,
        tick("alert"),
        "America/Sao_Paulo",
      );
      expect(verdicts?.opened).toHaveLength(1);
      failing = true;
      const before = calls;
      await forecastOneStore(
        database.db,
        service("down"),
        { ...job(), hour: 11 },
        async () => history(),
      );
      expect(calls).toBe(before + 1);
      const failed = await database.db
        .selectFrom("order_monitor_forecasts")
        .select([
          "status",
          "error",
          "series_sent",
          "orders",
          "so_far_orders",
          "baseline_close_orders",
          "pred_close_orders",
        ])
        .where("organization_id", "=", on.organizationId)
        .where("local_date", "=", "2026-11-26")
        .where("hour", "=", 11)
        .executeTakeFirstOrThrow();
      expect(failed).toEqual({
        status: "failed",
        error: "forecast service answered 500",
        // Hour 11 has no stored forecasts yet: today plus a backfill batch.
        series_sent: 2 + 2 * BACKFILL_DAYS_PER_RUN,
        orders: null,
        so_far_orders: 40,
        baseline_close_orders: 100,
        pred_close_orders: null,
      });
      const latest = await storage.latestForecast(
        on.organizationId,
        on.connectionId,
        "2026-11-26",
      );
      expect(latest?.hour).toBe(10);
      expect(
        (await storage.listStates(on.organizationId, on.connectionId)).map(
          (s) => [s.rule, s.status],
        ),
      ).toEqual(expect.arrayContaining([["orders_drop", "alert"]]));
      expect(
        (await new AlertStorage(database.db).list(on.organizationId)).alerts,
      ).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("an org's forecasts go with the org", async () => {
    await sql`DELETE FROM "organization" WHERE id = ${on.organizationId}`.execute(
      database.db,
    );
    expect(
      await database.db
        .selectFrom("order_monitor_forecasts")
        .select("hour")
        .where("organization_id", "=", on.organizationId)
        .execute(),
    ).toEqual([]);
  });
});
