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
import type { ForecastJob } from "./order-forecast";
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
  const read = { timezone: "America/Sao_Paulo", done: 40, backfill: [] };
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
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      calls++;
      const body = (await req.json()) as { series: unknown[]; horizon: number };
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
    });
    expect(jobs).toEqual([due(on), due(other)]);
    setGlobalSettings(resolveConfig({}));
    expect(await planForecasts(database.db, swept, at)).toEqual([]);
  });

  test("clears forecasts over three days old on every tick", async () => {
    setGlobalSettings(resolveConfig({}));
    const row = (computedAt: Date) => ({
      hour: 9,
      orders: new Array<number>(15).fill(1),
      revenue: new Array<number>(15).fill(1),
      ratios: [],
      computedAt,
    });
    const day = 24 * 60 * 60_000;
    await storage.upsertForecast(
      on.organizationId,
      on.connectionId,
      "2026-11-22",
      row(new Date(at.getTime() - 3 * day - 60_000)),
    );
    await storage.upsertForecast(
      on.organizationId,
      on.connectionId,
      "2026-11-23",
      row(new Date(at.getTime() - 3 * day + 60_000)),
    );
    await planForecasts(database.db, swept, at);
    expect(
      await storage.latestForecast(
        on.organizationId,
        on.connectionId,
        "2026-11-22",
      ),
    ).toBeNull();
    expect(
      await storage.latestForecast(
        on.organizationId,
        on.connectionId,
        "2026-11-23",
      ),
    ).not.toBeNull();
  });

  const job = (): ForecastJob => ({
    organizationId: on.organizationId,
    connectionId: on.connectionId,
    timezone: "America/Sao_Paulo",
    at: new Date().toISOString(),
    date: "2026-11-26",
    hour: 10,
    backfill: [],
  });

  test("stores the model's forecast for the store hour, and a re-run replaces it", async () => {
    failing = false;
    value = 4;
    await forecastOneStore(database.db, service("ok"), job(), async () =>
      history(),
    );
    const first = await storage.latestForecast(
      on.organizationId,
      on.connectionId,
      "2026-11-26",
    );
    expect(first?.hour).toBe(10);
    expect(first?.orders).toEqual(new Array(14).fill(4));
    // Each calibration day brought 14 × 10 orders against 14 × 4 forecast.
    expect(first?.ratios[0]).toEqual({
      daysAgo: 1,
      orders: 140 / 56,
      revenue: 14_000 / 56,
    });
    value = 5;
    await forecastOneStore(database.db, service("ok"), job(), async () =>
      history(),
    );
    const rows = await database.db
      .selectFrom("order_monitor_forecasts")
      .select(["hour", "orders"])
      .where("organization_id", "=", on.organizationId)
      .where("local_date", "=", "2026-11-26")
      .execute();
    expect(rows).toEqual([{ hour: 10, orders: new Array(14).fill(5) }]);
  });

  test("a failed forecast writes nothing and leaves the verdicts alone", async () => {
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
