import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Meter, trace } from "@opentelemetry/api";
import type { OrderMonitorVerdict } from "@decocms/shared/order-monitor";
import { sql } from "kysely";
import {
  ContextFactory,
  createStudioContextFactory,
} from "@/core/context-factory";
import type { BetterAuthInstance, StudioContext } from "@/core/studio-context";
import type { StudioDatabase } from "@/database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "@/database/test-db-pg";
import type { QueryEngine } from "@/monitoring/query-engine";
import { OrderMonitorStorage } from "@/storage/order-monitor";
import { buildOrgContext } from "@/tools/task-board/org-context";
import { writeStates } from "./dbos-order-monitor";
import { syncIncidentTask } from "./order-incidents";

const ORG = "org_incident_test";
const ADMIN = "user_incident_admin";
const STORE = "conn_incident_store";
const noopEngine: QueryEngine = { query: async () => [] };

describe("syncIncidentTask", () => {
  let database: StudioDatabase;
  let ctx: StudioContext;
  let storage: OrderMonitorStorage;

  const verdict = (
    over: Partial<OrderMonitorVerdict>,
  ): OrderMonitorVerdict => ({
    status: "warning",
    from: 56,
    to: 60,
    observed: 10,
    expected: 40,
    warnAt: 12,
    alertAt: 6,
    level: 1,
    timezone: "America/Sao_Paulo",
    ...over,
  });
  const at = new Date("2026-10-19T18:05:00Z");
  const state = async () =>
    (await storage.listStates(ORG, STORE)).find(
      (s) => s.rule === "orders_drop",
    );
  const notifications = () =>
    database.db
      .selectFrom("notifications")
      .select(["type", "user_id", "data"])
      .where("organization_id", "=", ORG)
      .execute();

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    ContextFactory.set(
      await createStudioContextFactory({
        db: database.db,
        // Inert: a user-less org context never authenticates anything.
        auth: { api: {} } as unknown as BetterAuthInstance,
        encryption: { key: "test_key" },
        observability: {
          tracer: trace.getTracer("test"),
          meter: {} as unknown as Meter,
        },
        monitoringEngines: {
          monitoringEngine: noopEngine,
          metricEngine: noopEngine,
        },
      }),
    );
    const now = new Date().toISOString();
    await sql`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (${ORG}, ${ORG}, ${ORG}, ${now})`.execute(
      database.db,
    );
    await sql`INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt") VALUES (${ADMIN}, ${`${ADMIN}@example.com`}, false, 'Admin', ${now}, ${now})`.execute(
      database.db,
    );
    await sql`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES ('mem_incident', ${ORG}, ${ADMIN}, 'owner', ${now})`.execute(
      database.db,
    );
    await database.db
      .insertInto("connections")
      .values({
        id: STORE,
        organization_id: ORG,
        created_by: ADMIN,
        updated_by: null,
        title: "Test Store",
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
    storage = new OrderMonitorStorage(database.db);
    await storage.upsertStates(ORG, STORE, [
      {
        rule: "orders_drop",
        status: "warning",
        since: at,
        evaluatedAt: at,
        verdict: {},
      },
    ]);
    ctx = (await buildOrgContext(database.db, ORG))!;
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  test("opens one unassigned card in intake and tells the admins", async () => {
    const id = await syncIncidentTask(ctx, database.db, storage, {
      organizationId: ORG,
      connectionId: STORE,
      rule: "orders_drop",
      action: "open",
      verdict: verdict({}),
      at,
      since: at,
    });
    expect(id).toBeTruthy();
    const card = await ctx.storage.taskBoard.getById(id!, ORG);
    expect(card).toMatchObject({
      title: "Orders at Test Store are 75 % below expected since 14:00",
      status: "triage",
      priority: "high",
      assigneeId: null,
    });
    expect(card?.description).toContain(
      `/${ORG}/settings/monitor?tab=stores&store=${STORE}&at=2026-10-19T17%3A00%3A00.000Z`,
    );
    expect(card?.description).toContain("None.");
    expect((await state())?.task?.id).toBe(id!);
    const [n] = await notifications();
    expect(n).toMatchObject({ type: "order_incident", user_id: ADMIN });
    expect(n?.data).toMatchObject({ incident: { store: "Test Store" } });
  });

  test("escalates the same card, stays quiet on a flap, then closes it to Done", async () => {
    const id = (await state())!.task!.id;
    const sync = (
      action: "update" | "pause" | "close",
      over: Partial<OrderMonitorVerdict>,
      since: Date = at,
    ) =>
      syncIncidentTask(ctx, database.db, storage, {
        organizationId: ORG,
        connectionId: STORE,
        rule: "orders_drop",
        action,
        verdict: verdict(over),
        at,
        since,
      });

    await sync("update", { status: "alert", observed: 2 });
    expect((await ctx.storage.taskBoard.getById(id, ORG))?.priority).toBe(
      "urgent",
    );
    // Back to warning, then alert again: the same incident, nobody is told.
    await sync("update", { status: "warning" });
    await sync("update", { status: "alert", observed: 3 });
    // Too few orders overnight: a note on the card, nobody is told.
    await sync("pause", { status: "low-volume" });

    const linked = await sync(
      "close",
      { status: "ok", observed: 45 },
      new Date("2026-10-19T17:35:00Z"),
    );
    expect(linked).toBeNull();
    expect((await ctx.storage.taskBoard.getById(id, ORG))?.status).toBe("done");
    expect((await state())?.task).toBeNull();
    const comments = await ctx.storage.taskBoard.listComments(id, ORG);
    expect(comments.map((c) => c.body.split(".")[0])).toEqual([
      "Now **alert**",
      "Too few orders to judge since 15:05",
      "Back to normal since 14:35",
    ]);
    expect(await notifications()).toHaveLength(3);
    // No status_changed entry: a Done lane automation must not fire on it.
    const moves = await database.db
      .selectFrom("task_board_activity")
      .select("action")
      .where("task_board_item_id", "=", id)
      .where("action", "=", "status_changed")
      .execute();
    expect(moves).toEqual([]);
  });

  test("a replayed open finds the card already linked", async () => {
    const open = () =>
      syncIncidentTask(ctx, database.db, storage, {
        organizationId: ORG,
        connectionId: STORE,
        rule: "orders_drop",
        action: "open",
        verdict: verdict({}),
        at,
        since: at,
      });
    const id = await open();
    expect(await open()).toBe(id);
  });

  test("an older tick that lost the race writes nothing over a newer one", async () => {
    const store = {
      organizationId: ORG,
      connectionId: STORE,
      createdBy: ADMIN,
    };
    const verdicts = (status: OrderMonitorVerdict["status"]) => ({
      orders_drop: verdict({ status }),
      denied_spike: verdict({ status: "ok" }),
      cancel_spike: verdict({ status: "ok" }),
    });
    const later = new Date(at.getTime() + 5 * 60_000);
    await writeStates(database.db, store, later, verdicts("warning"), "UTC");
    await storage.setVerdictFlags(ORG, STORE, "orders_drop", {
      crossCheckPending: true,
    });
    expect(
      await writeStates(database.db, store, at, verdicts("ok"), "UTC"),
    ).toBeNull();
    expect((await state())?.status).toBe("warning");

    // A newer tick still in the incident keeps the open waiting on VTEX.
    const next = new Date(later.getTime() + 5 * 60_000);
    await writeStates(database.db, store, next, verdicts("alert"), "UTC");
    expect((await state())?.verdict.crossCheckPending).toBe(true);
  });
});
