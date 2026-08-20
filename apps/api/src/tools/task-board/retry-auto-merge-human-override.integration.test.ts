/**
 * Real-Postgres coverage for the sweeper's own auto-merge retry honoring the
 * human-override guard `hasHumanRejectedDone` added (#6231) to the two other
 * auto-completing paths (`prs-get`'s reconcile, `review-decision`'s inline
 * merge) but not to this one — so a card a member dragged out of Done could
 * still be silently re-merged and re-closed on the sweeper's next visit.
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
import { OrganizationSettingsStorage } from "../../storage/organization-settings";
import { TaskBoardStorage } from "../../storage/task-board";
import { retryAutoMergeIfApproved } from "./merge-pr";

const ORG = "org_retryautomerge_1";
const USER = "user_ram1";

describe("retryAutoMergeIfApproved", () => {
  let database: StudioDatabase;
  let taskBoard: TaskBoardStorage;
  let organizationSettings: OrganizationSettingsStorage;
  let ctx: StudioContext;

  /** A card In Review, every enabled reviewer verifiably approved, no PR linked. */
  const approvedCard = async () => {
    const item = await taskBoard.create({
      organizationId: ORG,
      title: "ship me",
      by: USER,
      status: "in_review",
    });
    for (const reviewer of ["qa", "code_review"]) {
      await taskBoard.recordActivity({
        taskBoardItemId: item.id,
        action: "review_approved",
        actorId: null,
        data: { reviewer, verified: true },
      });
    }
    return { ...item, status: "in_review" as const };
  };

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const now = new Date().toISOString();
    await database.db
      .insertInto("organization")
      .values({
        id: ORG,
        name: ORG,
        slug: "org-retryautomerge-1",
        createdAt: now,
      })
      .execute();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${"ram1@retryautomerge.test"}, false, ${USER}, ${now}, ${now})
    `.execute(database.db);
    taskBoard = new TaskBoardStorage(database.db);
    organizationSettings = new OrganizationSettingsStorage(database.db);
    await organizationSettings.upsert(ORG, {
      flags: {
        auto_merge: true,
        qa_agent_enabled: true,
        code_reviewer_enabled: true,
      },
    });
    ctx = {
      storage: { taskBoard, organizationSettings },
    } as unknown as StudioContext;
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  // A missing merge attempt with no PR linked always logs `no_pr` — its absence proves the short-circuit.
  it("does not attempt a merge once a member has dragged the card out of Done", async () => {
    const item = await approvedCard();
    await taskBoard.recordActivity({
      taskBoardItemId: item.id,
      action: "status_changed",
      actorId: USER,
      data: { from: "done", to: "in_review" },
    });

    expect(await retryAutoMergeIfApproved(ctx, item)).toBe(false);

    const activity = await taskBoard.listActivity(item.id, ORG);
    expect(activity.some((a) => a.action === "merge_failed")).toBe(false);
  });

  it("still attempts a merge for an untouched approved card", async () => {
    const item = await approvedCard();

    expect(await retryAutoMergeIfApproved(ctx, item)).toBe(false);

    const activity = await taskBoard.listActivity(item.id, ORG);
    expect(activity.some((a) => a.action === "merge_failed")).toBe(true);
  });
});
