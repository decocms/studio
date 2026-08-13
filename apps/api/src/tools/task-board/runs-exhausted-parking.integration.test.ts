/**
 * Real-Postgres coverage for the two halves of the wedge that left four prod
 * cards sitting In Review with nothing running and no reason on the card:
 *
 * 1. `parkOnRunsExhausted` — the per-task run cap refuses an AUTOMATIC
 *    re-dispatch, and the card must say so instead of the refusal dying in a
 *    log line. Real PG rather than a stub because the hand-off is a conditional
 *    UPDATE on `assignee_id` plus an activity row, and both are exactly what an
 *    in-memory fake gets to be lenient about (it also has to be idempotent, and
 *    only a real conditional write proves that).
 *
 * 2. `outstandingReviewFeedback` over rows that made a round trip through
 *    `recordActivity`/`listActivity`. The pure test builds its own fixtures, so
 *    it cannot catch the failure that actually matters here: the storage row's
 *    shape (`occurredAt` as a string the fold can order by, `data.notes`
 *    surviving the jsonb round trip) drifting from what the fold reads. A
 *    mismatch there degrades silently — every re-run would just quietly go back
 *    to restarting from scratch, which is the bug this was written to fix.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import type { StudioContext } from "../../core/studio-context";
import type { StudioDatabase } from "../../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../../database/test-db-pg";
import { TaskBoardStorage } from "../../storage/task-board";
import { TaskQuotaError } from "../../billing/task-quota";
import {
  outstandingReviewFeedback,
  SUPER_AGENT_ASSIGNEE_ID,
} from "@decocms/shared/task-board";
import { parkOnRunsExhausted } from "./run-reactions";

const ORG = "org_runs_exhausted";
const USER = "user_runs_exhausted";

describe("runs-exhausted parking", () => {
  let database: StudioDatabase;
  let taskBoard: TaskBoardStorage;
  let ctx: StudioContext;

  /** A card delegated to the Super Agent, sitting In Review — the shape all
   *  four prod cards were in when they stopped moving. */
  const delegatedCard = async (title: string) => {
    const item = await taskBoard.create({
      organizationId: ORG,
      title,
      by: USER,
      assigneeId: SUPER_AGENT_ASSIGNEE_ID,
    });
    return await taskBoard.update(item.id, ORG, { status: "in_review" }, USER);
  };

  const assigneeOf = async (id: string) =>
    (await taskBoard.getById(id, ORG))?.assigneeId ?? null;

  const handoffReasons = async (id: string) =>
    (await taskBoard.listActivity(id, ORG))
      .filter((a) => a.action === "assignee_changed")
      .map((a) => (a.data as { reason?: string } | null)?.reason ?? null);

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const now = new Date().toISOString();
    await database.db
      .insertInto("organization")
      .values({
        id: ORG,
        name: ORG,
        slug: "org-runs-exhausted",
        createdAt: now,
      })
      .execute();
    // Raw SQL: real Postgres types emailVerified BOOLEAN, the table shape TEXT.
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${"re@exhausted.test"}, false, ${USER}, ${now}, ${now})
    `.execute(database.db);
    taskBoard = new TaskBoardStorage(database.db);
    ctx = { storage: { taskBoard } } as unknown as StudioContext;
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("hands the card to a human, with the reason, when the run cap refuses", async () => {
    const card = await delegatedCard("cap refused me");

    const handled = await parkOnRunsExhausted(
      ctx,
      card,
      new TaskQuotaError("runs_exhausted"),
    );

    expect(handled).toBe(true);
    expect(await assigneeOf(card.id)).toBeNull();
    // The reason is the whole point: the prod cards were unassigned with no
    // explanation a person could act on.
    const [reason] = await handoffReasons(card.id);
    expect(reason).toContain("per-task run limit reached");
    expect(reason).toContain("Re-run it manually");
  });

  it("leaves the card In Review — a human picks it up where the reviewers left it", async () => {
    const card = await delegatedCard("still in review");
    await parkOnRunsExhausted(ctx, card, new TaskQuotaError("runs_exhausted"));
    expect((await taskBoard.getById(card.id, ORG))?.status).toBe("in_review");
  });

  it("is idempotent — a second refusal does not log a second hand-off", async () => {
    const card = await delegatedCard("swept twice");
    await parkOnRunsExhausted(ctx, card, new TaskQuotaError("runs_exhausted"));
    // The sweeper visits a card every tick, and `card` is now stale in exactly
    // the way a re-read at the top of the next tick is not.
    await parkOnRunsExhausted(ctx, card, new TaskQuotaError("runs_exhausted"));
    expect(await handoffReasons(card.id)).toHaveLength(1);
  });

  it("ignores the org-wide paywall reasons and non-quota errors", async () => {
    const paywalled = await delegatedCard("trial over");
    expect(
      await parkOnRunsExhausted(
        ctx,
        paywalled,
        new TaskQuotaError("trial_exhausted"),
      ),
    ).toBe(false);
    expect(await assigneeOf(paywalled.id)).toBe(SUPER_AGENT_ASSIGNEE_ID);

    const blipped = await delegatedCard("network blip");
    expect(
      await parkOnRunsExhausted(ctx, blipped, new Error("ECONNRESET")),
    ).toBe(false);
    expect(await assigneeOf(blipped.id)).toBe(SUPER_AGENT_ASSIGNEE_ID);
  });

  it("reads the outstanding change request back off real activity rows", async () => {
    const card = await delegatedCard("bounced then re-run");
    await taskBoard.recordActivity({
      taskBoardItemId: card.id,
      action: "review_approved",
      actorId: null,
      data: { reviewer: "code_review", notes: "looks good to me" },
    });
    await taskBoard.recordActivity({
      taskBoardItemId: card.id,
      action: "review_changes_requested",
      actorId: null,
      data: {
        reviewer: "qa",
        notes: "the fix is right — do not redo the approach",
      },
    });

    expect(
      outstandingReviewFeedback(await taskBoard.listActivity(card.id, ORG)),
    ).toBe("the fix is right — do not redo the approach");
  });

  it("carries nothing once the latest verdict is an approval", async () => {
    const card = await delegatedCard("approved after the bounce");
    await taskBoard.recordActivity({
      taskBoardItemId: card.id,
      action: "review_changes_requested",
      actorId: null,
      data: { reviewer: "qa", notes: "needs work" },
    });
    await taskBoard.recordActivity({
      taskBoardItemId: card.id,
      action: "review_approved",
      actorId: null,
      data: { reviewer: "qa", notes: "fixed" },
    });

    expect(
      outstandingReviewFeedback(await taskBoard.listActivity(card.id, ORG)),
    ).toBeNull();
  });
});
