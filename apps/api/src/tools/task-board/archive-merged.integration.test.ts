/**
 * Real-Postgres coverage for the auto-archive sweep: the candidate query's
 * four shapes (the SQL is the whole gate — an in-memory fake would happily
 * accept a predicate Postgres reads differently) and the archive write path,
 * including the activity entry and its idempotence.
 *
 * The PR-merged read is injected, so the sweep runs without a GitHub
 * connection — every other part of the path is the real one.
 */

import { OrganizationSettingsStorage } from "@/storage/organization-settings";
import { ColumnAutomationStorage } from "@/storage/task-board-column-automations";
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
      storage: {
        taskBoard,
        // The sweep now asks the board where a finished card retires to, and
        // the board asks the org which board it is.
        organizationSettings: new OrganizationSettingsStorage(database.db),
        columnAutomations: new ColumnAutomationStorage(database.db),
      },
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

  // A shipped delivery-lane card never reaches literal `done` — see `shippedLane`.
  it("sweeps a settled card resting in a delivery lane, same as Done", async () => {
    const settled = new Date(Date.now() - 3 * DAY_MS);
    const lanes = ["approved", "merged", "post_deploy_validation"] as const;
    const parked = await Promise.all(
      lanes.map((lane) => seed(lane, settled, true)),
    );

    const candidates = await taskBoard.listItemsAwaitingArchive(
      new Date(Date.now() - DAY_MS),
      200,
    );
    const ids = candidates.map((c) => c.id);
    for (const id of parked) expect(ids).toContain(id);

    const swept = await archiveMergedForOrg(ctx, ORG, parked, async () => ({
      state: "closed" as const,
      merged: true,
    }));
    expect(swept.archived).toBe(lanes.length);
    for (const id of parked) {
      expect((await taskBoard.getById(id, ORG))?.status).toBe("archived");
    }
  });

  it("archives a merged card, logs it, and won't archive it twice", async () => {
    const id = await seed("done", new Date(Date.now() - 3 * DAY_MS), true);

    const first = await archiveMergedForOrg(ctx, ORG, [id], async () => ({
      state: "closed" as const,
      merged: true,
    }));
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
    const second = await archiveMergedForOrg(ctx, ORG, [id], async () => ({
      state: "closed" as const,
      merged: true,
    }));
    expect(second.archived).toBe(0);
  });

  /**
   * The org-owned board's `archiveColumn()` names a row the foreign key can
   * hold a card to (#6710/#6723). The sweep must guard the card the same way
   * `update.ts` does, or it retires the card into that row without the
   * discriminator the key needs to notice.
   */
  it("archives past an abandoned PR, and waits on a second repo", async () => {
    const settled = new Date(Date.now() - 3 * DAY_MS);
    const link = (id: string, prNumber: number, repoName: string) =>
      taskBoard.linkPr({
        taskBoardItemId: id,
        organizationId: ORG,
        url: `https://github.com/acme/${repoName}/pull/${prNumber}`,
        prNumber,
        repoOwner: "acme",
        repoName,
      });

    const bounced = await seed("done", settled, false);
    await link(bounced, 1, "repo");
    await link(bounced, 2, "repo");

    const twoRepos = await seed("done", settled, false);
    await link(twoRepos, 3, "repo");
    await link(twoRepos, 4, "repo-us");

    // PR 1 is the branch a reviewer bounce walked away from; 4 is the second
    // repo's, still open.
    const reader = async (
      _ctx: StudioContext,
      _orgId: string,
      pr: { number: number },
    ) =>
      pr.number === 1
        ? { state: "closed" as const, merged: false }
        : pr.number === 4
          ? { state: "open" as const, merged: false }
          : { state: "closed" as const, merged: true };

    expect(
      (await archiveMergedForOrg(ctx, ORG, [bounced, twoRepos], reader))
        .archived,
    ).toBe(1);
    expect((await taskBoard.getById(bounced, ORG))?.status).toBe("archived");
    expect((await taskBoard.getById(twoRepos, ORG))?.status).toBe("done");
  });

  it("leaves a card alone when GitHub can't confirm the merge", async () => {
    const unknown = await seed("done", new Date(Date.now() - 3 * DAY_MS), true);
    const open = await seed("done", new Date(Date.now() - 3 * DAY_MS), true);

    expect(
      (
        await archiveMergedForOrg(ctx, ORG, [unknown], async () => ({
          state: null,
          merged: null,
        }))
      ).archived,
    ).toBe(0);
    expect(
      (
        await archiveMergedForOrg(ctx, ORG, [open], async () => ({
          state: "open" as const,
          merged: false,
        }))
      ).archived,
    ).toBe(0);
    expect((await taskBoard.getById(unknown, ORG))?.status).toBe("done");
    expect((await taskBoard.getById(open, ORG))?.status).toBe("done");
  });
});
