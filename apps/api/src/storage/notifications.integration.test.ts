/**
 * Real-Postgres coverage for the notification queries.
 *
 * Every rule this feature has is a SQL predicate — the sticky opt-out is
 * `on conflict do nothing`, "never notify your own action" is
 * `is distinct from`, the multi-pod fence is a conditional `on conflict do
 * update`. None of that can be tested against a fake, and `on conflict … where`
 * in particular is exactly the semantic PGlite gets wrong, so this tier is
 * where the policy lives.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import { NotificationStorage } from "./notifications";
import { TaskBoardStorage } from "./task-board";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";

const ORG = "org_notifications";
const OTHER_ORG = "org_notifications_other";
const ALICE = "user_notif_alice";
const BOB = "user_notif_bob";
const CAROL = "user_notif_carol";
/** Untouched by the cursor/claim cases above, so the digest tests can assert
 *  on a clean watermark. */
const DAVE = "user_notif_dave";

describe("NotificationStorage (real Postgres)", () => {
  let database: StudioDatabase;
  let notifications: NotificationStorage;
  let taskBoard: TaskBoardStorage;

  const seedUser = async (id: string, email: string) => {
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${id}, ${email}, false, ${id}, ${now}, ${now})
      ON CONFLICT (id) DO NOTHING
    `.execute(database.db);
  };

  const seedOrg = async (id: string, slug: string) => {
    await database.db
      .insertInto("organization")
      .values({
        id,
        name: id,
        slug,
        createdAt: new Date().toISOString(),
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
  };

  const seedMember = async (userId: string, organizationId: string) => {
    await database.db
      .insertInto("member")
      .values({
        id: `mem_${organizationId}_${userId}`,
        organizationId,
        userId,
        role: "member",
        createdAt: new Date().toISOString(),
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
  };

  const task = (title: string) =>
    taskBoard.create({ organizationId: ORG, title, by: ALICE });

  /** An activity row attributed to `actorId`, `agoMs` in the past. */
  const activity = async (
    taskId: string,
    actorId: string | null,
    agoMs = 0,
  ) => {
    await taskBoard.recordActivity({
      taskBoardItemId: taskId,
      action: "commented",
      actorId,
    });
    if (agoMs > 0) {
      await sql`
        UPDATE task_board_activity
        SET occurred_at = now() - make_interval(secs => ${agoMs / 1000})
        WHERE task_board_item_id = ${taskId}
      `.execute(database.db);
    }
  };

  /** The inbox narrowed to one card: the feed is org-wide, and these cases
   *  share a subscriber, so a global count would drift as tests accumulate. */
  const inboxFor = async (userId: string, orgId: string, taskId: string) =>
    (await notifications.listInbox(userId, orgId, 50)).filter(
      (n) => n.taskBoardItemId === taskId,
    );

  /** Age a subscription so back-dated activity still clears its floor. */
  const backdateSubscription = async (taskId: string, agoMs: number) => {
    await sql`
      UPDATE task_board_subscribers
      SET created_at = now() - make_interval(secs => ${agoMs / 1000})
      WHERE task_board_item_id = ${taskId}
    `.execute(database.db);
  };

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedOrg(ORG, "org-notifications");
    await seedOrg(OTHER_ORG, "org-notifications-other");
    await seedUser(ALICE, "alice@notif.test");
    await seedUser(BOB, "bob@notif.test");
    await seedUser(CAROL, "carol@notif.test");
    await seedUser(DAVE, "dave@notif.test");
    await seedMember(ALICE, ORG);
    await seedMember(BOB, ORG);
    await seedMember(DAVE, ORG);
    notifications = new NotificationStorage(database.db);
    taskBoard = new TaskBoardStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  describe("subscriptions", () => {
    it("subscribes and lists, opt-outs excluded", async () => {
      const item = await task("subscribe and list");
      await notifications.setSubscribed(item.id, ALICE, true);
      await notifications.setSubscribed(item.id, BOB, true);
      expect((await notifications.listSubscribers(item.id)).sort()).toEqual(
        [ALICE, BOB].sort(),
      );

      await notifications.setSubscribed(item.id, BOB, false);
      expect(await notifications.listSubscribers(item.id)).toEqual([ALICE]);
    });

    it("auto-subscribe cannot resurrect an explicit opt-out", async () => {
      const item = await task("sticky opt-out");
      await notifications.setSubscribed(item.id, ALICE, false);

      await notifications.autoSubscribe(item.id, [ALICE]);

      expect(await notifications.listSubscribers(item.id)).toEqual([]);
    });

    it("auto-subscribe drops the agent sentinel and unknown ids", async () => {
      const item = await task("machine actors");

      await notifications.autoSubscribe(item.id, [
        SUPER_AGENT_ASSIGNEE_ID,
        "user_does_not_exist",
        null,
        undefined,
        ALICE,
      ]);

      expect(await notifications.listSubscribers(item.id)).toEqual([ALICE]);
    });

    it("deleting the task takes its subscriptions", async () => {
      const item = await task("cascade");
      await notifications.autoSubscribe(item.id, [ALICE]);

      await taskBoard.delete(item.id, ORG, ALICE);

      expect(await notifications.listSubscribers(item.id)).toEqual([]);
    });
  });

  describe("the pending-activity policy", () => {
    it("surfaces a teammate's action", async () => {
      const item = await task("teammate acted");
      await notifications.autoSubscribe(item.id, [ALICE]);
      await activity(item.id, BOB);

      const mine = await inboxFor(ALICE, ORG, item.id);

      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({
        taskTitle: "teammate acted",
        action: "commented",
        actorId: BOB,
      });
    });

    it("never surfaces your own action", async () => {
      const item = await task("my own action");
      await notifications.autoSubscribe(item.id, [ALICE]);
      await activity(item.id, ALICE);

      expect(await inboxFor(ALICE, ORG, item.id)).toEqual([]);
    });

    it("surfaces the agent's action, which has no actor at all", async () => {
      const item = await task("agent acted");
      await notifications.autoSubscribe(item.id, [ALICE]);
      await activity(item.id, null);

      const mine = await inboxFor(ALICE, ORG, item.id);
      expect(mine).toHaveLength(1);
      expect(mine[0]?.actorId).toBeNull();
    });

    it("ignores activity that predates the subscription", async () => {
      const item = await task("old news");
      await activity(item.id, BOB, 60_000);
      await notifications.autoSubscribe(item.id, [ALICE]);

      expect(await inboxFor(ALICE, ORG, item.id)).toEqual([]);
    });

    it("stops for a user who left the org", async () => {
      const item = await task("departed member");
      await notifications.autoSubscribe(item.id, [CAROL]);
      await activity(item.id, BOB);

      // Carol is subscribed but was never a member — no membership, no feed.
      expect(await inboxFor(CAROL, ORG, item.id)).toEqual([]);
    });

    it("is org-scoped", async () => {
      const item = await task("wrong org");
      await notifications.autoSubscribe(item.id, [ALICE]);
      await activity(item.id, BOB);

      expect(await inboxFor(ALICE, OTHER_ORG, item.id)).toEqual([]);
    });
  });

  describe("read cursor", () => {
    it("clears the inbox, and never moves backwards", async () => {
      const item = await task("mark read");
      await notifications.autoSubscribe(item.id, [ALICE]);
      await activity(item.id, BOB);
      expect(await inboxFor(ALICE, ORG, item.id)).toHaveLength(1);

      await notifications.markRead(ALICE, ORG, new Date());
      expect(await inboxFor(ALICE, ORG, item.id)).toEqual([]);

      const advanced = (await notifications.readState(ALICE, ORG)).lastReadAt;
      await notifications.markRead(ALICE, ORG, new Date(0));
      expect((await notifications.readState(ALICE, ORG)).lastReadAt).toBe(
        advanced,
      );
    });
  });

  describe("digest claim", () => {
    it("only the first claimant wins", async () => {
      const through = new Date();

      expect(await notifications.claimDigest(BOB, ORG, through, null)).toBe(
        true,
      );
      // A second pod holding the same stale witness must lose.
      expect(await notifications.claimDigest(BOB, ORG, through, null)).toBe(
        false,
      );
      // The pod that read the new value can claim the next window.
      expect(
        await notifications.claimDigest(
          BOB,
          ORG,
          new Date(through.getTime() + 1000),
          through,
        ),
      ).toBe(true);
    });

    it("a claim hides the events it covered", async () => {
      const item = await task("claimed digest");
      await notifications.autoSubscribe(item.id, [ALICE]);
      await activity(item.id, BOB);

      const eventsFor = async (taskId: string) =>
        (await notifications.loadDigestEvents(ALICE, ORG, new Date())).filter(
          (e) => e.taskBoardItemId === taskId,
        );

      expect(await eventsFor(item.id)).toHaveLength(1);

      // Claiming advances the cursor past everything up to `through`.
      await notifications.claimDigest(ALICE, ORG, new Date(), null);

      expect(
        await notifications.loadDigestEvents(ALICE, ORG, new Date()),
      ).toEqual([]);
    });
  });

  describe("digest candidates", () => {
    it("requires the org flag, and the coalesce window to have passed", async () => {
      const item = await task("digest candidate");
      await notifications.autoSubscribe(item.id, [DAVE]);
      await activity(item.id, BOB, 10 * 60_000);
      await backdateSubscription(item.id, 20 * 60_000);

      // No flag row at all: not a candidate.
      expect(await notifications.listDueDigests(60_000, 50)).toEqual([]);

      await database.db
        .insertInto("organization_settings")
        .values({
          organizationId: ORG,
          flags: JSON.stringify({ task_notifications: true }),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .onConflict((oc) =>
          oc.column("organizationId").doUpdateSet({
            flags: JSON.stringify({ task_notifications: true }),
          }),
        )
        .execute();

      const due = await notifications.listDueDigests(60_000, 50);
      const mine = due.filter((d) => d.userId === DAVE);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({
        organizationId: ORG,
        userEmail: "dave@notif.test",
        organizationSlug: "org-notifications",
      });
      expect(mine[0]!.eventCount).toBeGreaterThanOrEqual(1);

      // A window longer than the oldest event's age is not yet due.
      expect(
        (await notifications.listDueDigests(60 * 60_000, 50)).filter(
          (d) => d.userId === DAVE,
        ),
      ).toEqual([]);
    });
  });

  describe("member name resolution", () => {
    it("resolves members and refuses non-members", async () => {
      const names = await notifications.resolveMemberNames(ORG, [
        BOB,
        CAROL,
        "user_nobody",
      ]);

      expect(names.get(BOB)).toBe(BOB);
      expect(names.has(CAROL)).toBe(false);
      expect(names.has("user_nobody")).toBe(false);
    });
  });
});
