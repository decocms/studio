import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "@/database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "@/database/test-db-pg";
import { AlertStorage } from "@/storage/alerts";
import type { MonitoredStore } from "@/storage/order-monitor";
import { writeStates } from "./dbos-order-monitor";
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

describe("writeStates opens an alert when a rule crosses into alert", () => {
  let database: StudioDatabase;
  let alerts: AlertStorage;
  const write = (at: Date, drop: Verdict["status"]) =>
    writeStates(database.db, STORE, at, tick(drop), "America/Sao_Paulo");

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    alerts = new AlertStorage(database.db);
    const now = new Date().toISOString();
    await sql`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (${ORG}, ${ORG}, ${STORE.orgSlug}, ${now})`.execute(
      database.db,
    );
    await sql`INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt") VALUES (${USER}, ${`${USER}@example.com`}, false, 'Sweep', ${now}, ${now})`.execute(
      database.db,
    );
    await database.db
      .insertInto("connections")
      .values({
        id: STORE.connectionId,
        organization_id: ORG,
        created_by: USER,
        updated_by: null,
        title: STORE.title,
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
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  test("ok and warning open nothing", async () => {
    expect((await write(minute(3), "ok"))?.opened).toEqual([]);
    expect((await write(minute(8), "warning"))?.opened).toEqual([]);
    expect(await alerts.list(ORG)).toEqual([]);
  });

  test("the crossing opens one alert, and a re-run of that tick keeps it one", async () => {
    const first = await write(minute(13), "alert");
    expect(first?.opened).toHaveLength(1);
    const rerun = await write(minute(13), "alert");
    expect(rerun?.opened).toEqual([]);

    const open = await alerts.list(ORG);
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
    const [open] = await alerts.list(ORG);
    await alerts.ack(ORG, open!.id, USER);
    expect((await write(minute(23), "alert"))?.opened).toEqual([]);
    expect(await alerts.list(ORG)).toEqual([]);
  });

  test("after the ack, the next crossing opens a new alert", async () => {
    await write(minute(28), "ok");
    const again = await write(minute(33), "alert");
    expect(again?.opened).toHaveLength(1);
    expect((await alerts.list(ORG)).map((a) => a.id)).toEqual(again!.opened);
  });

  test("an older tick that lost the race writes nothing and opens nothing", async () => {
    await write(minute(38), "ok");
    expect(await write(minute(36), "alert")).toBeNull();
    expect(await alerts.list(ORG)).toHaveLength(1);
  });
});
