import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import { AlertStorage } from "./alerts";
import { TaskBoardStorage } from "./task-board";

describe("AlertStorage", () => {
  let database: StudioDatabase;
  let alerts: AlertStorage;
  const orgId = "org_alerts_test";
  const otherOrg = "org_alerts_other";
  const userId = "user_alerts_test";

  const drop = (org = orgId, subjectId = "conn_store") => ({
    organizationId: org,
    source: "order_monitor",
    subjectId,
    rule: "orders_drop",
    title: "Orders at Store are 90 % below expected since 14:15",
  });

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    alerts = new AlertStorage(database.db);
    const now = new Date().toISOString();
    for (const id of [orgId, otherOrg]) {
      await sql`
        INSERT INTO "organization" (id, name, slug, "createdAt")
        VALUES (${id}, ${id}, ${id}, ${now})
      `.execute(database.db);
    }
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${userId}, ${`${userId}@example.com`}, false, 'Alerts', ${now}, ${now})
    `.execute(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  test("keeps one open alert per subject and rule until it is acked", async () => {
    const first = await alerts.open({
      ...drop(),
      body: "Orders: 4 between 14:15 and 15:15 vs 40 expected.",
      link: "/org/settings/monitor?tab=stores",
    });
    expect(first).toMatchObject({
      source: "order_monitor",
      subjectId: "conn_store",
      rule: "orders_drop",
      body: "Orders: 4 between 14:15 and 15:15 vs 40 expected.",
      link: "/org/settings/monitor?tab=stores",
      ackedAt: null,
      taskBoardItemId: null,
    });
    expect(first?.id).toStartWith("alert_");

    // The rule fires again while it is open: nothing new.
    expect(await alerts.open(drop())).toBeNull();
    // Another store, another rule or another org each get their own.
    expect(await alerts.open(drop(orgId, "conn_other"))).not.toBeNull();
    expect(
      await alerts.open({ ...drop(), rule: "cancel_spike" }),
    ).not.toBeNull();
    expect(await alerts.open(drop(otherOrg))).not.toBeNull();

    expect(
      (await alerts.list(orgId)).alerts.map((a) => a.subjectId).sort(),
    ).toEqual(["conn_other", "conn_store", "conn_store"]);
    expect((await alerts.list(otherOrg)).alerts).toHaveLength(1);
  });

  test("acks in the org only, links the task, and lets the rule alert again", async () => {
    const [open] = (await alerts.list(orgId)).alerts.filter(
      (a) => a.subjectId === "conn_store" && a.rule === "orders_drop",
    );
    expect(open).toBeDefined();

    // Another org can't ack it.
    expect(await alerts.ack(otherOrg, open!.id, userId)).toBeNull();

    const task = await new TaskBoardStorage(database.db).create({
      organizationId: orgId,
      title: "Look into the orders drop",
      by: userId,
    });
    const acked = await alerts.ack(orgId, open!.id, userId, {
      note: "Checkout was down for 40 min",
      taskBoardItemId: task.id,
    });
    expect(acked).toMatchObject({
      ackedBy: userId,
      ackedByName: "Alerts",
      ackNote: "Checkout was down for 40 min",
      taskBoardItemId: task.id,
      taskKeySeq: task.keySeq,
    });
    expect(acked?.ackedAt).not.toBeNull();

    // A second ack leaves the first one's record.
    const again = await alerts.ack(orgId, open!.id, "someone_else", {
      note: "late",
    });
    expect(again).toMatchObject({ ackedBy: userId, ackedAt: acked!.ackedAt });

    expect((await alerts.list(orgId)).alerts.map((a) => a.id)).not.toContain(
      open!.id,
    );
    expect(
      (await alerts.list(orgId, { status: "all" })).alerts.map((a) => a.id),
    ).toContain(open!.id);

    // The next crossing opens a fresh alert.
    const reopened = await alerts.open(drop());
    expect(reopened).not.toBeNull();
    expect(reopened?.id).not.toBe(open!.id);

    // Which alerts became tasks is a join away; deleting the task keeps the alert.
    const linked = await database.db
      .selectFrom("alerts as a")
      .innerJoin("task_board_items as t", "t.id", "a.task_board_item_id")
      .select(["a.id", "t.title"])
      .where("a.organization_id", "=", orgId)
      .execute();
    expect(linked).toEqual([
      { id: open!.id, title: "Look into the orders drop" },
    ]);
    await database.db
      .deleteFrom("task_board_items")
      .where("id", "=", task.id)
      .execute();
    const [kept] = (await alerts.list(orgId, { status: "all" })).alerts.filter(
      (a) => a.id === open!.id,
    );
    expect(kept?.taskBoardItemId).toBeNull();
    expect(kept?.taskKeySeq).toBeNull();
  });

  test("keeps one threshold setting per org, source and rule", async () => {
    expect(await alerts.listRuleSettings(orgId, "order_monitor")).toEqual([]);
    const set = (threshold: number) =>
      alerts.setRuleSetting(
        orgId,
        {
          source: "order_monitor",
          rule: "orders_drop",
          threshold,
          minVolume: 25,
        },
        userId,
      );
    await set(30);
    await set(40);
    expect(await alerts.listRuleSettings(orgId, "order_monitor")).toMatchObject(
      [
        {
          rule: "orders_drop",
          threshold: 40,
          minVolume: 25,
          updatedBy: userId,
        },
      ],
    );
    expect(await alerts.listRuleSettings(orgId, "other_source")).toEqual([]);
    expect(await alerts.listRuleSettings(otherOrg, "order_monitor")).toEqual(
      [],
    );
  });

  test("pages by status, newest first, ties on the same instant included", async () => {
    const at = new Date("2026-01-01T12:00:00Z");
    for (let i = 0; i < 5; i++) {
      const a = await alerts.open({
        ...drop(orgId, `conn_page_${i}`),
        // Two pairs share an instant: the cursor must not skip either.
        createdAt: new Date(at.getTime() - Math.floor(i / 2) * 60_000),
      });
      await alerts.ack(orgId, a!.id, userId);
    }
    const acked = await alerts.list(orgId, { status: "acked", limit: 100 });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await alerts.list(orgId, {
        status: "acked",
        limit: 2,
        cursor,
      });
      expect(page.alerts.length).toBeLessThanOrEqual(2);
      seen.push(...page.alerts.map((a) => a.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(acked.alerts.map((a) => a.id));
    expect(new Set(seen).size).toBe(seen.length);
    expect(
      (await alerts.list(orgId, { status: "acked", limit: 100 })).alerts.every(
        (a) => a.ackedAt !== null,
      ),
    ).toBe(true);
    expect(
      (await alerts.list(orgId, { limit: 100 })).alerts.every(
        (a) => a.ackedAt === null,
      ),
    ).toBe(true);
    // A malformed cursor reads as the first page.
    expect(
      (await alerts.list(orgId, { status: "acked", limit: 2, cursor: "x" }))
        .alerts[0]?.id,
    ).toBe(acked.alerts[0]?.id);
  });

  test("opens a crossing once, whether re-judged or acked in between", async () => {
    const hour = new Date("2026-11-18T16:00:00Z");
    const crossing = {
      organizationId: orgId,
      source: "site_traffic",
      subjectId: "s1",
      rule: "pageviews_drop",
      title: "Pageviews on site are 70 % below expected since 13:00",
      createdAt: hour,
    };
    const first = await alerts.openOnce(crossing);
    expect(first?.createdAt).toBe(hour.toISOString());
    expect(await alerts.openOnce(crossing)).toBeNull();
    await alerts.ack(orgId, first!.id, userId);
    expect(await alerts.openOnce(crossing)).toBeNull();
    // The next crossing, a later hour, opens anew.
    const next = await alerts.openOnce({
      ...crossing,
      createdAt: new Date("2026-11-18T19:00:00Z"),
    });
    expect(next).not.toBeNull();
    expect(next?.id).not.toBe(first!.id);
  });

  test("goes with its organization", async () => {
    await sql`DELETE FROM "organization" WHERE id = ${otherOrg}`.execute(
      database.db,
    );
    expect(
      (await alerts.list(otherOrg, { status: "all" })).alerts,
    ).toHaveLength(0);
  });
});
