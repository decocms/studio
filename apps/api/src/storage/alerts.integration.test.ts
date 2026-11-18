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

    expect((await alerts.list(orgId)).map((a) => a.subjectId).sort()).toEqual([
      "conn_other",
      "conn_store",
      "conn_store",
    ]);
    expect(await alerts.list(otherOrg)).toHaveLength(1);
  });

  test("acks in the org only, links the task, and lets the rule alert again", async () => {
    const [open] = (await alerts.list(orgId)).filter(
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

    expect((await alerts.list(orgId)).map((a) => a.id)).not.toContain(open!.id);
    expect(
      (await alerts.list(orgId, { includeAcked: true })).map((a) => a.id),
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
    const [kept] = (await alerts.list(orgId, { includeAcked: true })).filter(
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

  test("goes with its organization", async () => {
    await sql`DELETE FROM "organization" WHERE id = ${otherOrg}`.execute(
      database.db,
    );
    expect(await alerts.list(otherOrg, { includeAcked: true })).toHaveLength(0);
  });
});
