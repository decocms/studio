/**
 * Real-Postgres coverage for the one thing a re-run must NOT do: throw away a
 * merge that is already queued.
 *
 * A re-run starts a new review cycle, and the auto-merge gate reads only the
 * current one — so re-running a card every reviewer already approved discards
 * the pending merge and hands the PR back to a review loop that can bounce
 * until a human is called in. Real PG rather than a fake because the gate is a
 * fold over `task_board_activity` rows plus the org's `flags` jsonb, and both
 * are exactly what an in-memory stub gets to be lenient about.
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
import { refuseIfMergePending } from "./rerun";

const ORG = "org_rerun_1";
const USER = "user_r1";

describe("refuseIfMergePending", () => {
  let database: StudioDatabase;
  let taskBoard: TaskBoardStorage;
  let organizationSettings: OrganizationSettingsStorage;
  let ctx: StudioContext;

  /** A card In Review whose reviewers left `verdicts` in the current cycle. */
  const cardWithVerdicts = async (
    verdicts: { reviewer: string; verified: boolean }[],
  ) => {
    const item = await taskBoard.create({
      organizationId: ORG,
      title: "ship me",
      by: USER,
    });
    for (const { reviewer, verified } of verdicts) {
      await taskBoard.recordActivity({
        taskBoardItemId: item.id,
        action: "review_approved",
        actorId: null,
        data: { reviewer, verified },
      });
    }
    return { id: item.id, status: "in_review", organizationId: ORG };
  };

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const now = new Date().toISOString();
    await database.db
      .insertInto("organization")
      .values({ id: ORG, name: ORG, slug: "org-rerun-1", createdAt: now })
      .execute();
    // Raw SQL: real Postgres types emailVerified BOOLEAN, the table shape TEXT.
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${"r1@rerun.test"}, false, ${USER}, ${now}, ${now})
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

  it("refuses when every enabled reviewer verifiably approved", async () => {
    const item = await cardWithVerdicts([
      { reviewer: "qa", verified: true },
      { reviewer: "code_review", verified: true },
    ]);
    await expect(refuseIfMergePending(ctx, item)).rejects.toThrow(
      /merge is retrying/,
    );
  });

  it("allows a re-run when a reviewer has not approved yet", async () => {
    const item = await cardWithVerdicts([{ reviewer: "qa", verified: true }]);
    await expect(refuseIfMergePending(ctx, item)).resolves.toBeUndefined();
  });

  // An unverified approval is the dead end a re-run is the only way out of.
  it("allows a re-run when an approval did not verify", async () => {
    const item = await cardWithVerdicts([
      { reviewer: "qa", verified: true },
      { reviewer: "code_review", verified: false },
    ]);
    await expect(refuseIfMergePending(ctx, item)).resolves.toBeUndefined();
  });

  it("allows a re-run of a card that is not In Review", async () => {
    const item = await cardWithVerdicts([
      { reviewer: "qa", verified: true },
      { reviewer: "code_review", verified: true },
    ]);
    await expect(
      refuseIfMergePending(ctx, { ...item, status: "in_progress" }),
    ).resolves.toBeUndefined();
  });

  it("allows a re-run when the org has auto-merge off", async () => {
    const item = await cardWithVerdicts([
      { reviewer: "qa", verified: true },
      { reviewer: "code_review", verified: true },
    ]);
    await organizationSettings.upsert(ORG, {
      flags: {
        auto_merge: false,
        qa_agent_enabled: true,
        code_reviewer_enabled: true,
      },
    });
    await expect(refuseIfMergePending(ctx, item)).resolves.toBeUndefined();
  });
  // The deadlock escape must not open on a guess: with a PR linked but its
  // mergeability unreadable (no GitHub connection in this org), the guard keeps
  // refusing. A `null` that fell through to "not deadlocked... so allow" would
  // re-open the very bug this guard was written for, on every read blip.
  it("still refuses when the PR's mergeability cannot be read", async () => {
    // Re-arm the flag: the auto-merge-off case above mutates the shared org.
    await organizationSettings.upsert(ORG, {
      flags: {
        auto_merge: true,
        qa_agent_enabled: true,
        code_reviewer_enabled: true,
      },
    });
    const item = await cardWithVerdicts([
      { reviewer: "qa", verified: true },
      { reviewer: "code_review", verified: true },
    ]);
    await taskBoard.linkPr({
      taskBoardItemId: item.id,
      organizationId: ORG,
      url: "https://github.com/acme/widgets/pull/7",
      prNumber: 7,
      repoOwner: "acme",
      repoName: "widgets",
    });
    // Cap already spent — so ONLY the unknown conflict signal keeps the refusal.
    for (let i = 0; i < 3; i++) {
      await taskBoard.recordActivity({
        taskBoardItemId: item.id,
        action: "merge_conflict_resolution",
        actorId: null,
        data: { prNumber: 7 },
      });
    }
    await expect(refuseIfMergePending(ctx, item)).rejects.toThrow(
      /merge is retrying/,
    );
  });
});
