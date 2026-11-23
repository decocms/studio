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
    expect(await goals.setActive(ORG, ANA, picked)).toBe(true);
    expect(await goals.activeGoalId(ORG, ANA)).toBe(picked);
    expect(await goals.activeGoalId(ORG, BIA)).toBe(oldest);

    expect(await goals.setActive(ORG, ANA, foreign)).toBe(false);
    expect(await goals.setActive(ORG, ANA, "goal_missing")).toBe(false);
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
    ).toBe(false);
    expect(
      await goals.recordCase({
        organizationId: ORG,
        threadId: "t2",
        goalId: foreign,
        userId: ANA,
      }),
    ).toBe(false);
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
});
