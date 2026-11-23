/**
 * Real-Postgres coverage for Plan goals. The contracts live in SQL: the
 * open-goal limit counted in the same INSERT, the seed that runs once, the
 * archive that clears members' picks in one transaction, the usage count
 * derived from two tables, and every query staying inside its org.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { sql } from "kysely";
import { MAX_OPEN_PLAN_GOALS } from "@decocms/shared/plan-goals";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import { PlanGoalStorage, seededGoalId } from "./plan-goals";

const ORG = "org_goals_1";
const OTHER_ORG = "org_goals_2";
const ANA = "user_goals_ana";
const BIA = "user_goals_bia";

describe("PlanGoalStorage", () => {
  let database: StudioDatabase;
  let goals: PlanGoalStorage;

  const create = async (statement: string, by = ANA, org = ORG) => {
    const id = await goals.create({
      organizationId: org,
      statement,
      source: null,
      by,
    });
    if (!id) throw new Error("expected a goal");
    return id;
  };

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const now = new Date().toISOString();
    for (const user of [ANA, BIA]) {
      await sql`
        INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
        VALUES (${user}, ${`${user}@test.com`}, false, ${user}, ${now}, ${now})
      `.execute(database.db);
    }
    for (const [id, slug] of [
      [ORG, "goals-one"],
      [OTHER_ORG, "goals-two"],
    ] as const) {
      await database.db
        .insertInto("organization")
        .values({ id, name: id, slug, createdAt: now })
        .execute();
    }
    goals = new PlanGoalStorage(database.db);
  });

  beforeEach(async () => {
    await database.db.deleteFrom("plan_goal_cases").execute();
    await database.db.deleteFrom("member_plan_state").execute();
    await database.db.deleteFrom("plan_goals").execute();
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("lists an org's open goals oldest first, and nothing from another org", async () => {
    const first = await create("Grow online revenue 30% in 2027");
    const second = await create("Cut return rate below 12%", BIA);
    await create("Another org's goal", ANA, OTHER_ORG);

    const list = await goals.list(ORG, ANA, false);
    expect(list.map((goal) => goal.id)).toEqual([first, second]);
    expect(list[0]).toMatchObject({
      statement: "Grow online revenue 30% in 2027",
      source: null,
      users: 0,
      last_case_at: null,
      mine: true,
      can_edit: true,
    });
    expect(list[1]).toMatchObject({ mine: false, can_edit: false });
    expect((await goals.list(ORG, ANA, true))[1]?.can_edit).toBe(true);
  });

  it("keeps the source a goal was found in", async () => {
    const id = await goals.create({
      organizationId: ORG,
      statement: "Make the app our main channel",
      source: {
        label: "Q3 kickoff.md",
        quote: "the app becomes our main channel",
      },
      by: ANA,
    });
    const [goal] = await goals.list(ORG, ANA, false);
    expect(goal?.id).toBe(id!);
    expect(goal?.source).toEqual({
      label: "Q3 kickoff.md",
      quote: "the app becomes our main channel",
    });
  });

  it("refuses a goal past the open limit, and counts only open goals", async () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_OPEN_PLAN_GOALS; i++) {
      ids.push(await create(`Goal ${i}`));
    }
    expect(
      await goals.create({
        organizationId: ORG,
        statement: "One too many",
        source: null,
        by: ANA,
      }),
    ).toBeNull();
    // The other org has its own limit.
    expect(await create("Elsewhere", ANA, OTHER_ORG)).toBeString();

    await goals.archive(ORG, ids[0]!, ANA);
    expect(await create("Fits after an archive")).toBeString();
  });

  it("rejects a blank statement at the database", async () => {
    await expect(create("   ")).rejects.toThrow();
  });

  it("seeds the first goal from the store goal once, and never over existing goals", async () => {
    const objective = {
      statement: " Grow online revenue ",
      updated_by: ANA,
      updated_at: "2026-01-02T03:04:05.000Z",
    };
    await Promise.all([
      goals.seedFromObjective(ORG, objective),
      goals.seedFromObjective(ORG, objective),
    ]);
    const list = await goals.list(ORG, BIA, false);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: seededGoalId(ORG),
      statement: "Grow online revenue",
      created_by: ANA,
      created_at: "2026-01-02T03:04:05.000Z",
    });

    // An org that already had goals, even only archived ones, is not seeded.
    const archived = await create("Old", ANA, OTHER_ORG);
    await goals.archive(OTHER_ORG, archived, ANA);
    await goals.seedFromObjective(OTHER_ORG, objective);
    expect(await goals.list(OTHER_ORG, ANA, false)).toEqual([]);
  });

  it("opens on the picked goal, falls back to the oldest open one, and ignores other orgs' goals", async () => {
    expect(await goals.activeGoalId(ORG, ANA)).toBeNull();
    const oldest = await create("Oldest");
    const picked = await create("Picked");
    const foreign = await create("Foreign", ANA, OTHER_ORG);

    expect(await goals.activeGoalId(ORG, ANA)).toBe(oldest);
    expect(await goals.setActive(ORG, ANA, picked)).toBe(picked);
    expect(await goals.activeGoalId(ORG, ANA)).toBe(picked);
    expect(await goals.activeGoalId(ORG, BIA)).toBe(oldest);

    expect(await goals.setActive(ORG, ANA, foreign)).toBeNull();
    expect(await goals.setActive(ORG, ANA, "goal_missing")).toBeNull();
    expect(await goals.activeGoalId(ORG, ANA)).toBe(picked);
  });

  it("counts each person once whether they picked a goal, started cases toward it, or both", async () => {
    const goal = await create("Shared", BIA);
    await goals.setActive(ORG, ANA, goal);
    await goals.recordCase({
      organizationId: ORG,
      threadId: "t1",
      goalId: goal,
      userId: ANA,
    });
    await goals.recordCase({
      organizationId: ORG,
      threadId: "t2",
      goalId: goal,
      userId: ANA,
    });
    await goals.recordCase({
      organizationId: ORG,
      threadId: "t3",
      goalId: goal,
      userId: BIA,
    });

    const [listed] = await goals.list(ORG, ANA, false);
    expect(listed?.users).toBe(2);
    expect(listed?.mine).toBe(true);
    expect(listed?.last_case_at).toBeString();
    expect(await goals.caseThreadIds(ORG, goal, 10)).toEqual([
      "t3",
      "t2",
      "t1",
    ]);
    expect(await goals.caseThreadIds(ORG, goal, 2)).toHaveLength(2);
  });

  it("keeps the first goal a case was recorded toward", async () => {
    const first = await create("First");
    const second = await create("Second");
    await goals.recordCase({
      organizationId: ORG,
      threadId: "t1",
      goalId: first,
      userId: ANA,
    });
    await goals.recordCase({
      organizationId: ORG,
      threadId: "t1",
      goalId: second,
      userId: ANA,
    });
    expect(await goals.caseThreadIds(ORG, first, 10)).toEqual(["t1"]);
    expect(await goals.caseThreadIds(ORG, second, 10)).toEqual([]);
  });

  it("refuses cases toward an archived goal or another org's goal", async () => {
    const goal = await create("Archived soon");
    const foreign = await create("Foreign", ANA, OTHER_ORG);
    await goals.archive(ORG, goal, ANA);
    expect(
      await goals.recordCase({
        organizationId: ORG,
        threadId: "t1",
        goalId: goal,
        userId: ANA,
      }),
    ).toBeNull();
    expect(
      await goals.recordCase({
        organizationId: ORG,
        threadId: "t2",
        goalId: foreign,
        userId: ANA,
      }),
    ).toBeNull();
  });

  it("archives once, clears everyone's pick of it, and keeps its cases", async () => {
    const oldest = await create("Oldest");
    const goal = await create("To archive");
    await goals.setActive(ORG, ANA, goal);
    await goals.setActive(ORG, BIA, goal);
    await goals.recordCase({
      organizationId: ORG,
      threadId: "t1",
      goalId: goal,
      userId: ANA,
    });

    expect(await goals.archive(ORG, goal, ANA)).toBe(true);
    expect(await goals.archive(ORG, goal, ANA)).toBe(false);

    expect((await goals.list(ORG, ANA, false)).map((g) => g.id)).toEqual([
      oldest,
    ]);
    expect(await goals.activeGoalId(ORG, ANA)).toBe(oldest);
    expect(await goals.activeGoalId(ORG, BIA)).toBe(oldest);
    const states = await database.db
      .selectFrom("member_plan_state")
      .select("active_goal_id")
      .execute();
    expect(states.map((s) => s.active_goal_id)).toEqual([null, null]);
    expect(await goals.caseThreadIds(ORG, goal, 10)).toEqual(["t1"]);
    expect((await goals.get(ORG, goal))?.open).toBe(false);
    expect(await goals.updateStatement(ORG, goal, "Too late", ANA)).toBe(false);
  });

  it("rewords only an open goal of the same org", async () => {
    const goal = await create("Draft");
    expect(await goals.updateStatement(OTHER_ORG, goal, "Hijack", BIA)).toBe(
      false,
    );
    expect(await goals.updateStatement(ORG, goal, "Final", BIA)).toBe(true);
    const stored = await goals.get(ORG, goal);
    expect(stored).toMatchObject({
      statement: "Final",
      updated_by: BIA,
      created_by: ANA,
    });
    expect(await goals.get(OTHER_ORG, goal)).toBeNull();
  });

  it("goes away with its organization", async () => {
    const now = new Date().toISOString();
    await database.db
      .insertInto("organization")
      .values({
        id: "org_goals_gone",
        name: "gone",
        slug: "goals-gone",
        createdAt: now,
      })
      .execute();
    const goal = await create("Doomed", ANA, "org_goals_gone");
    await goals.setActive("org_goals_gone", ANA, goal);
    await goals.recordCase({
      organizationId: "org_goals_gone",
      threadId: "t1",
      goalId: goal,
      userId: ANA,
    });
    await database.db
      .deleteFrom("organization")
      .where("id", "=", "org_goals_gone")
      .execute();
    for (const table of [
      "plan_goals",
      "member_plan_state",
      "plan_goal_cases",
    ] as const) {
      const rows = await database.db
        .selectFrom(table)
        .select("organization_id")
        .where("organization_id", "=", "org_goals_gone")
        .execute();
      expect(rows).toEqual([]);
    }
  });

  describe("merge", () => {
    const mergedInto = async (id: string) =>
      (
        await database.db
          .selectFrom("plan_goals")
          .select("merged_into_id")
          .where("id", "=", id)
          .executeTakeFirstOrThrow()
      ).merged_into_id;

    /** Hold a row lock on a goal, as a merge in another request would. */
    const holdLock = async (id: string) => {
      let release = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked = () => {};
      const isLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const done = database.db.transaction().execute(async (trx) => {
        await trx
          .selectFrom("plan_goals")
          .select("id")
          .where("id", "=", id)
          .forUpdate()
          .execute();
        locked();
        await released;
      });
      await isLocked;
      return async () => {
        release();
        await done;
      };
    };

    const waitingOnLocks = async (count: number) => {
      for (let i = 0; i < 200; i++) {
        const { rows } = await sql<{ n: string }>`
          SELECT count(*) AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'
        `.execute(database.db);
        if (Number(rows[0]?.n) >= count) return;
        await Bun.sleep(10);
      }
      throw new Error(`expected ${count} sessions waiting on a lock`);
    };

    it("keeps one goal with the approved sentence and moves its people and cases to it", async () => {
      const target = await create("Grow app sales", ANA);
      const source = await create("Sell more on the app", BIA);
      const other = await create("Cut returns");
      await goals.setActive(ORG, ANA, target);
      await goals.setActive(ORG, BIA, source);
      await goals.recordCase({
        organizationId: ORG,
        threadId: "t1",
        goalId: source,
        userId: BIA,
      });
      await goals.recordCase({
        organizationId: ORG,
        threadId: "t2",
        goalId: target,
        userId: ANA,
      });

      expect(
        await goals.merge(
          ORG,
          source,
          target,
          "Make the app our main channel",
          BIA,
        ),
      ).toBe(true);

      const list = await goals.list(ORG, ANA, false);
      expect(list.map((goal) => goal.id)).toEqual([target, other]);
      expect(list[0]).toMatchObject({
        statement: "Make the app our main channel",
        updated_by: BIA,
        created_by: ANA,
        users: 2,
      });
      expect(await goals.activeGoalId(ORG, BIA)).toBe(target);
      expect((await goals.caseThreadIds(ORG, target, 10)).sort()).toEqual([
        "t1",
        "t2",
      ]);
      expect(await goals.caseThreadIds(ORG, source, 10)).toEqual([]);
      expect((await goals.get(ORG, source))?.open).toBe(false);
      expect(await mergedInto(source)).toBe(target);
      expect(await goals.updateStatement(ORG, source, "Too late", BIA)).toBe(
        false,
      );
      expect(await goals.archive(ORG, source, BIA)).toBe(false);
    });

    it("resolves a merged goal to the one it went into, even after that one merges again", async () => {
      const a = await create("A");
      const b = await create("B");
      const c = await create("C");
      expect(await goals.merge(ORG, a, b, "B", ANA)).toBe(true);

      expect(await goals.setActive(ORG, ANA, a)).toBe(b);
      expect(
        await goals.recordCase({
          organizationId: ORG,
          threadId: "t1",
          goalId: a,
          userId: ANA,
        }),
      ).toBe(b);

      expect(await goals.merge(ORG, b, c, "C", ANA)).toBe(true);
      expect(await mergedInto(a)).toBe(c);
      expect(await goals.setActive(ORG, BIA, a)).toBe(c);
      expect(await goals.activeGoalId(ORG, ANA)).toBe(c);
      expect(await goals.caseThreadIds(ORG, c, 10)).toEqual(["t1"]);

      await goals.archive(ORG, c, ANA);
      expect(await goals.setActive(ORG, ANA, a)).toBeNull();
      expect(
        await goals.recordCase({
          organizationId: ORG,
          threadId: "t2",
          goalId: a,
          userId: ANA,
        }),
      ).toBeNull();
    });

    it("refuses the same goal twice, a missing goal, another org's goal, and goals no longer open", async () => {
      const goal = await create("Stays as it is");
      const foreign = await create("Foreign", ANA, OTHER_ORG);
      const archived = await create("Archived");
      await goals.archive(ORG, archived, ANA);
      const merged = await create("Merged");
      const survivor = await create("Survivor");
      await goals.merge(ORG, merged, survivor, "Survivor", ANA);

      expect(await goals.merge(ORG, goal, goal, "Same", ANA)).toBe(false);
      expect(await goals.merge(ORG, goal, "goal_missing", "X", ANA)).toBe(
        false,
      );
      expect(await goals.merge(ORG, goal, foreign, "X", ANA)).toBe(false);
      expect(await goals.merge(ORG, foreign, goal, "X", ANA)).toBe(false);
      expect(await goals.merge(OTHER_ORG, goal, survivor, "X", ANA)).toBe(
        false,
      );
      expect(await goals.merge(ORG, goal, archived, "X", ANA)).toBe(false);
      expect(await goals.merge(ORG, archived, goal, "X", ANA)).toBe(false);
      expect(await goals.merge(ORG, goal, merged, "X", ANA)).toBe(false);
      expect(await goals.merge(ORG, merged, goal, "X", ANA)).toBe(false);

      expect(await goals.get(ORG, goal)).toMatchObject({
        statement: "Stays as it is",
        open: true,
      });
      expect(await goals.get(OTHER_ORG, foreign)).toMatchObject({
        statement: "Foreign",
        open: true,
      });
      expect(await goals.get(ORG, survivor)).toMatchObject({
        statement: "Survivor",
        open: true,
      });
    });

    it("rejects a blank merged sentence at the database and changes nothing", async () => {
      const source = await create("Source");
      const target = await create("Target");
      await expect(
        goals.merge(ORG, source, target, "  ", ANA),
      ).rejects.toThrow();
      expect((await goals.get(ORG, source))?.open).toBe(true);
      expect((await goals.get(ORG, target))?.statement).toBe("Target");
    });

    it("lets only one of two merges of the same goal at once win", async () => {
      const source = await create("Source");
      const first = await create("First");
      const second = await create("Second");
      const results = await Promise.all([
        goals.merge(ORG, source, first, "First", ANA),
        goals.merge(ORG, source, second, "Second", BIA),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await mergedInto(source)).toBe(results[0] ? first : second);
    });

    it("leaves one goal when two people merge the same pair in opposite directions", async () => {
      const a = await create("A");
      const b = await create("B");
      const results = await Promise.all([
        goals.merge(ORG, a, b, "Kept B", ANA),
        goals.merge(ORG, b, a, "Kept A", BIA),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const list = await goals.list(ORG, ANA, false);
      expect(list).toHaveLength(1);
      expect(list[0]?.statement).toBe(results[0] ? "Kept B" : "Kept A");
    });

    it("never lets a merge and an archive of the goal that goes away both win", async () => {
      const source = await create("Source");
      const target = await create("Target");
      const [merged, archived] = await Promise.all([
        goals.merge(ORG, source, target, "Merged", ANA),
        goals.archive(ORG, source, ANA),
      ]);
      expect(merged).toBe(!archived);
      expect((await goals.list(ORG, ANA, false)).map((g) => g.id)).toEqual([
        target,
      ]);
    });

    it("archives the surviving goal after a merge that started first, never mid-merge", async () => {
      const source = await create("Source");
      const target = await create("Target");
      const [merged, archived] = await Promise.all([
        goals.merge(ORG, source, target, "Merged", ANA),
        goals.archive(ORG, target, ANA),
      ]);
      expect(archived).toBe(true);
      expect((await goals.list(ORG, ANA, false)).map((g) => g.id)).toEqual(
        merged ? [] : [source],
      );
      expect(await mergedInto(source)).toBe(merged ? target : null);
    });

    it("moves a case recorded while the merge holds its goals to the surviving goal", async () => {
      const source = await create("Source");
      const target = await create("Target");
      // Hold the goal the merge locks second, so it waits holding the first.
      const release = await holdLock(source > target ? source : target);
      const merging = goals.merge(ORG, source, target, "Merged", ANA);
      await waitingOnLocks(1);
      const recording = goals.recordCase({
        organizationId: ORG,
        threadId: "t1",
        goalId: source,
        userId: BIA,
      });
      await waitingOnLocks(2);
      await release();

      expect(await merging).toBe(true);
      expect(await recording).toBe(target);
      expect(await goals.caseThreadIds(ORG, target, 10)).toEqual(["t1"]);
      expect(await goals.caseThreadIds(ORG, source, 10)).toEqual([]);
    });
  });
});
