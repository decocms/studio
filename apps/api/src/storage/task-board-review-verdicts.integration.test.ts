/**
 * Real-Postgres coverage for `reviewVerdicts` on a board read.
 *
 * The board card's `1/2` checks indicator is drawn from this field, and it is
 * the same number the auto-merge gate acts on — so "which verdicts are still
 * current" has to be decided in exactly one place. Here that means the cycle
 * boundary: re-entering In Review invalidates every earlier verdict, and a
 * field that quietly kept them would show a green card that cannot ship.
 *
 * Real Postgres because the reduction spans two tables and depends on
 * `occurred_at` ordering across them; an in-memory fake would happily agree
 * with whatever the reducer did.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import { TaskBoardStorage } from "./task-board";
import type { TaskBoardActivityAction } from "../tools/task-board/schema";

const ORG = "org_review_verdicts";
const USER = "user_review_verdicts";

describe("reviewVerdicts (real Postgres)", () => {
  let database: StudioDatabase;
  let taskBoard: TaskBoardStorage;
  /** Monotonic clock for activity rows — the reduction is order-sensitive, so
   *  `now()` would make these tests race each other within a millisecond. */
  let tick = 0;

  const activity = async (
    taskId: string,
    action: TaskBoardActivityAction,
    data: Record<string, unknown>,
  ) => {
    tick += 1;
    await database.db
      .insertInto("task_board_activity")
      .values({
        id: `act_verdict_${tick}`,
        task_board_item_id: taskId,
        action,
        actor_id: null,
        data: JSON.stringify(data),
        occurred_at: new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString(),
      })
      .execute();
  };

  const enterReview = (taskId: string) =>
    activity(taskId, "status_changed", {
      from: "in_progress",
      to: "in_review",
    });

  const approve = (taskId: string, reviewer: string, verified = true) =>
    activity(taskId, "review_approved", { reviewer, verified });

  const requestChanges = (taskId: string, reviewer: string) =>
    activity(taskId, "review_changes_requested", { reviewer, notes: "nope" });

  const card = async (title: string) =>
    taskBoard.create({
      organizationId: ORG,
      title,
      status: "in_review",
      by: USER,
    });

  /** The verdicts as a board read reports them for one card. */
  const verdictsOf = async (taskId: string) => {
    const items = await taskBoard.list(ORG);
    const item = items.find((i) => i.id === taskId);
    expect(item).toBeDefined();
    return item?.reviewVerdicts ?? [];
  };

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await database.db
      .insertInto("organization")
      .values({
        id: ORG,
        name: ORG,
        slug: "org-review-verdicts",
        createdAt: new Date().toISOString(),
      })
      .execute();
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${"verdicts@review.test"}, false, ${USER}, ${now}, ${now})
    `.execute(database.db);
    taskBoard = new TaskBoardStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("is empty for a card with no review history", async () => {
    const item = await card("never reviewed");
    expect(await verdictsOf(item.id)).toEqual([]);
  });

  it("reports one entry per reviewer that decided, in REVIEWER_KINDS order", async () => {
    const item = await card("both decided");
    await enterReview(item.id);
    await approve(item.id, "code_review");
    await requestChanges(item.id, "qa");

    expect(await verdictsOf(item.id)).toEqual([
      { reviewer: "qa", verdict: "changes_requested", verified: false },
      { reviewer: "code_review", verdict: "approved", verified: true },
    ]);
  });

  it("omits a reviewer that has not decided yet", async () => {
    const item = await card("half decided");
    await enterReview(item.id);
    await approve(item.id, "qa");

    expect(await verdictsOf(item.id)).toEqual([
      { reviewer: "qa", verdict: "approved", verified: true },
    ]);
  });

  it("keeps only a reviewer's latest verdict within the cycle", async () => {
    const item = await card("changed its mind");
    await enterReview(item.id);
    await requestChanges(item.id, "qa");
    await approve(item.id, "qa");

    expect(await verdictsOf(item.id)).toEqual([
      { reviewer: "qa", verdict: "approved", verified: true },
    ]);
  });

  it("drops verdicts from before the card last re-entered In Review", async () => {
    const item = await card("bounced and re-reviewed");
    await enterReview(item.id);
    await approve(item.id, "qa");
    await approve(item.id, "code_review");
    expect(await verdictsOf(item.id)).toHaveLength(2);

    // The bounce: a change-request sends the card back, and returning to In
    // Review starts a fresh cycle that nothing has signed off on yet.
    await enterReview(item.id);
    expect(await verdictsOf(item.id)).toEqual([]);
  });

  it("marks an unverified approval as unverified, not as no approval", async () => {
    const item = await card("self-asserted approval");
    await enterReview(item.id);
    await approve(item.id, "qa", false);

    expect(await verdictsOf(item.id)).toEqual([
      { reviewer: "qa", verdict: "approved", verified: false },
    ]);
  });

  it("scopes verdicts to their own card", async () => {
    const mine = await card("mine");
    const theirs = await card("theirs");
    await enterReview(mine.id);
    await approve(mine.id, "qa");

    expect(await verdictsOf(mine.id)).toHaveLength(1);
    expect(await verdictsOf(theirs.id)).toEqual([]);
  });

  it("carries the same verdicts through a single-item read", async () => {
    const item = await card("single read");
    await enterReview(item.id);
    await approve(item.id, "code_review", false);

    const fetched = await taskBoard.getById(item.id, ORG);
    expect(fetched?.reviewVerdicts).toEqual([
      { reviewer: "code_review", verdict: "approved", verified: false },
    ]);
  });
});
