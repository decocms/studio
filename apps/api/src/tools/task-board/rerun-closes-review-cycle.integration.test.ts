/**
 * Real-Postgres coverage for a re-run closing the card's review cycle.
 *
 * `TASK_BOARD_ITEM_RERUN` moves a card back to In Progress, but until now it
 * never called `closeReviewCycle` — the storage method whose own doc comment
 * claims "every path that sends a card back to work (a rerun, a
 * conflict-resolution claim, a human re-engaging the thread)" calls it. Left
 * stamped, `openReviewCycleIfInProgress` (which only stamps a FRESH boundary
 * when the column is null) never fires for the new attempt, so its own review
 * dispatch inherits the superseded attempt's cycle boundary — and with it,
 * verdicts recorded against work the new run never produced.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../../database/test-db-pg";
import { TaskBoardStorage } from "../../storage/task-board";

/** Studio's own board, which is what these fixtures run on. */
const ORG = "org_rerun_cycle_1";
const USER = "user_rc1";

describe("a re-run closes the review cycle it inherited", () => {
  let database: StudioDatabase;
  let taskBoard: TaskBoardStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const now = new Date().toISOString();
    await database.db
      .insertInto("organization")
      .values({ id: ORG, name: ORG, slug: "org-rerun-cycle-1", createdAt: now })
      .execute();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${"rc1@rerun.test"}, false, ${USER}, ${now}, ${now})
    `.execute(database.db);
    taskBoard = new TaskBoardStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("lets a fresh cycle open after the sequence rerun.ts now runs", async () => {
    const item = await taskBoard.create({
      organizationId: ORG,
      title: "stuck mid-review",
      by: USER,
    });
    // A reviewer already stamped an open cycle — the state a rerun targets.
    const opened = await taskBoard.openReviewCycleIfInProgress(item.id, ORG);
    expect(opened?.reviewCycleStartedAt).not.toBeNull();

    // The exact sequence TASK_BOARD_ITEM_RERUN's handler now runs.
    await taskBoard.closeReviewCycle(item.id, ORG);
    await taskBoard.update(item.id, ORG, { status: "in_progress" }, USER);

    // Without the fix this returns null: the column is still non-null.
    const reopened = await taskBoard.openReviewCycleIfInProgress(item.id, ORG);
    expect(reopened).not.toBeNull();
    expect(reopened?.reviewCycleStartedAt).not.toBe(
      opened?.reviewCycleStartedAt,
    );
  });
});
