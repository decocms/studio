/**
 * A card ships once: it reaches Post-deploy Validation and later Done, and the
 * board analytics count it on the day it first shipped.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../database/test-db-pg";
import { TaskBoardStorage } from "./task-board";
import {
  type SeriesSection,
  type StatSection,
  TaskBoardAnalyticsStorage,
} from "./task-board-analytics";

const ORG = "org_test";
const QUERY = {
  orgIds: [ORG],
  from: "2026-01-01T00:00:00.000Z",
  to: "2026-01-10T00:00:00.000Z",
};

describe("task board analytics — shipped once", () => {
  let database: StudioDatabase;
  let analytics: TaskBoardAnalyticsStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    analytics = new TaskBoardAnalyticsStorage(database.db);
    const taskBoard = new TaskBoardStorage(database.db);
    const item = await taskBoard.create({
      organizationId: ORG,
      title: "ships, then is validated",
      by: "user_test",
    });
    const move = (to: string, at: string, actor: string | null) => ({
      id: `act_${to}`,
      task_board_item_id: item.id,
      action: "status_changed" as const,
      actor_id: actor,
      data: JSON.stringify({ to }),
      occurred_at: at,
    });
    await database.db
      .insertInto("task_board_activity")
      .values([
        move("in_progress", "2026-01-02T08:00:00.000Z", "user_test"),
        // The merge ships it, then a person validates it the next day.
        move("post_deploy_validation", "2026-01-02T10:00:00.000Z", null),
        move("done", "2026-01-03T09:00:00.000Z", "user_test"),
      ])
      .execute();
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("counts the card once, on the day it first shipped", async () => {
    const sections = await analytics.delivery(QUERY);
    const throughput = sections.find(
      (s): s is StatSection => s.kind === "stat" && s.title === "Throughput",
    );
    expect(
      throughput?.values.find((v) => v.label === "Tasks completed")?.value,
    ).toBe(1);
    const perDay = sections.find(
      (s): s is SeriesSection =>
        s.kind === "series" && s.title === "Completions per day",
    );
    expect(
      perDay?.points.map((p) => [String(p.t).slice(0, 10), p.Kanban]),
    ).toEqual([["2026-01-02", 1]]);
  });

  // The ship was the machine's; a person moving it on to Done is validation.
  it("reads autonomy from the move that shipped the card", async () => {
    const sections = await analytics.quality(QUERY);
    const autonomy = sections
      .flatMap((s) => (s.kind === "stat" ? s.values : []))
      .find((v) => v.label === "Autonomy (finished without a human)");
    expect(autonomy?.value).toBe(100);
  });
});
