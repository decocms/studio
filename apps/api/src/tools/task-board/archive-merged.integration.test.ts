/**
 * Real-Postgres coverage for the auto-archive sweep: the candidate query's
 * four shapes (the SQL is the whole gate — an in-memory fake would happily
 * accept a predicate Postgres reads differently) and the archive write path,
 * including the activity entry and its idempotence.
 *
 * The PR-merged read is injected, so the sweep runs without a GitHub
 * connection — every other part of the path is the real one.
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
import type { TaskBoardItemStatus } from "../../storage/types";
import { archiveMergedForOrg, groupByOrg } from "./archive-merged";

const ORG = "org_archive_1";
const USER = "user_a1";
const DAY_MS = 24 * 60 * 60 * 1000;

describe("auto-archive sweep", () => {
  let database: StudioDatabase;
  let taskBoard: TaskBoardStorage;
  let ctx: StudioContext;

  /**
   * A card in `status` with a chosen `updated_at`, optionally carrying a PR.
   * The timestamp is written directly because `create`/`update` always stamp it
   * to now, and it is the sweep's whole gate.
   */
  const seed = async (
    status: TaskBoardItemStatus,
    updatedAt: Date,
    withPr: boolean,
  ): Promise<string> => {
    const item = await taskBoard.create({
      organizationId: ORG,
      title: `${status}-${updatedAt.getTime()}-${withPr}`,
      status,
      by: USER,
    });
    await database.db
      .updateTable("task_board_items")
      .set({ updated_at: updatedAt })
      .where("id", "=", item.id)
      .execute();
    if (withPr) {
      await taskBoard.linkPr({
        taskBoardItemId: item.id,
        organizationId: ORG,
        url: `https://github.com/acme/repo/pull/${item.id}`,
        prNumber: 1,
        repoOwner: "acme",
        repoName: "repo",
      });
    }
    return item.id;
  };

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const now = new Date().toISOString();
    await database.db
      .insertInto("organization")
      .values({ id: ORG, name: ORG, slug: "org-archive-1", createdAt: now })
      .execute();
    // Raw SQL: real Postgres has a BOOLEAN emailVerified the typed shape disagrees with.
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${"a1@archive.test"}, false, ${USER}, ${now}, ${now})
    `.execute(database.db);
    taskBoard = new TaskBoardStorage(database.db);
    ctx = {
      auth: { user: { id: USER, email: "a1@archive.test", name: USER } },
      organization: { id: ORG, slug: "org-archive-1", name: ORG },
      storage: { taskBoard },
    } as unknown as StudioContext;
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("picks up only Done cards that have settled and have a PR", async () => {
    const settled = new Date(Date.now() - 3 * DAY_MS);
    const qualifies = await seed("done", settled, true);
    const tooFresh = await seed("done", new Date(), true);
    const noPr = await seed("done", settled, false);
    const notDone = await seed("in_review", settled, true);

    const candidates = await taskBoard.listItemsAwaitingArchive(
      new Date(Date.now() - DAY_MS),
      200,
    );
    const ids = candidates.map((c) => c.id);
    expect(ids).toContain(qualifies);
    expect(ids).not.toContain(tooFresh);
    expect(ids).not.toContain(noPr);
    expect(ids).not.toContain(notDone);
    expect(groupByOrg(candidates)).toEqual([
      { organizationId: ORG, itemIds: [qualifies] },
    ]);
  });

  it("archives a merged card, logs it, and won't archive it twice", async () => {
    const id = await seed("done", new Date(Date.now() - 3 * DAY_MS), true);

    const first = await archiveMergedForOrg(ctx, ORG, [id], async () => true);
    expect(first.archived).toBe(1);
    expect((await taskBoard.getById(id, ORG))?.status).toBe("archived");

    const activity = await taskBoard.listActivity(id, ORG);
    expect(activity).toContainEqual(
      expect.objectContaining({
        action: "status_changed",
        actorId: null,
        data: {
          from: "done",
          to: "archived",
          reason: "merged_pr_auto_archive",
        },
      }),
    );

    // No longer Done, so a second sweep must leave it alone.
    const second = await archiveMergedForOrg(ctx, ORG, [id], async () => true);
    expect(second.archived).toBe(0);
  });

  it("leaves a card alone when GitHub can't confirm the merge", async () => {
    const unknown = await seed("done", new Date(Date.now() - 3 * DAY_MS), true);
    const open = await seed("done", new Date(Date.now() - 3 * DAY_MS), true);

    expect(
      (await archiveMergedForOrg(ctx, ORG, [unknown], async () => null))
        .archived,
    ).toBe(0);
    expect(
      (await archiveMergedForOrg(ctx, ORG, [open], async () => false)).archived,
    ).toBe(0);
    expect((await taskBoard.getById(unknown, ORG))?.status).toBe("done");
    expect((await taskBoard.getById(open, ORG))?.status).toBe("done");
  });
});
