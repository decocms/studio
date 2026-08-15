/**
 * Real-Postgres coverage for the merged-tag sweep: the candidate query's four
 * shapes (the SQL is the whole gate — the "doesn't already carry the tag" leg
 * is a NOT EXISTS over a join an in-memory fake would happily get wrong) and
 * the tag write path, including the activity entry and its idempotence.
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
import { TagStorage } from "../../storage/tags";
import { TaskBoardStorage } from "../../storage/task-board";
import type { TaskBoardItemStatus } from "../../storage/types";
import { MERGED_TAG_NAME, tagMergedForOrg } from "./tag-merged";

const ORG = "org_mergedtag_1";
const USER = "user_m1";

describe("merged-tag sweep", () => {
  let database: StudioDatabase;
  let taskBoard: TaskBoardStorage;
  let tags: TagStorage;
  let ctx: StudioContext;

  const seed = async (
    status: TaskBoardItemStatus,
    withPr: boolean,
  ): Promise<string> => {
    const item = await taskBoard.create({
      organizationId: ORG,
      title: `${status}-${withPr}-${Math.random()}`,
      status,
      by: USER,
    });
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

  const candidateIds = async (): Promise<string[]> =>
    (await taskBoard.listItemsAwaitingMergedTag(MERGED_TAG_NAME, 200)).map(
      (c) => c.id,
    );

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const now = new Date().toISOString();
    await database.db
      .insertInto("organization")
      .values({ id: ORG, name: ORG, slug: "org-mergedtag-1", createdAt: now })
      .execute();
    // Raw SQL: real Postgres has a BOOLEAN emailVerified the typed shape disagrees with.
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${"m1@mergedtag.test"}, false, ${USER}, ${now}, ${now})
    `.execute(database.db);
    taskBoard = new TaskBoardStorage(database.db);
    tags = new TagStorage(database.db);
    ctx = {
      auth: { user: { id: USER, email: "m1@mergedtag.test", name: USER } },
      organization: { id: ORG, slug: "org-mergedtag-1", name: ORG },
      storage: { taskBoard, tags },
    } as unknown as StudioContext;
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("picks up every Done card with a PR, however old, and nothing else", async () => {
    const qualifies = await seed("done", true);
    const noPr = await seed("done", false);
    const notDone = await seed("in_review", true);

    const ids = await candidateIds();
    expect(ids).toContain(qualifies);
    expect(ids).not.toContain(noPr);
    expect(ids).not.toContain(notDone);
  });

  it("tags a merged card, logs it, and drops it from the work list", async () => {
    const id = await seed("done", true);

    const first = await tagMergedForOrg(ctx, ORG, [id], async () => true);
    expect(first.tagged).toBe(1);
    expect(
      (await taskBoard.getById(id, ORG))?.tags.map((t) => t.name),
    ).toContain(MERGED_TAG_NAME);

    const activity = await taskBoard.listActivity(id, ORG);
    expect(activity).toContainEqual(
      expect.objectContaining({
        action: "tags_changed",
        actorId: null,
        data: expect.objectContaining({ reason: "merged_pr_auto_tag" }),
      }),
    );

    // Already tagged, so the SQL gate must not hand it back next tick.
    expect(await candidateIds()).not.toContain(id);
  });

  it("reuses the org's one merged tag across cards", async () => {
    const a = await seed("done", true);
    const b = await seed("done", true);

    await tagMergedForOrg(ctx, ORG, [a, b], async () => true);

    const merged = (await tags.listOrgTags(ORG)).filter(
      (t) => t.name.toLowerCase() === MERGED_TAG_NAME,
    );
    expect(merged).toHaveLength(1);
  });

  it("leaves a card alone when GitHub can't confirm the merge", async () => {
    const unknown = await seed("done", true);
    const open = await seed("done", true);

    expect(
      (await tagMergedForOrg(ctx, ORG, [unknown], async () => null)).tagged,
    ).toBe(0);
    expect(
      (await tagMergedForOrg(ctx, ORG, [open], async () => false)).tagged,
    ).toBe(0);
    expect((await taskBoard.getById(unknown, ORG))?.tags).toEqual([]);
    expect((await taskBoard.getById(open, ORG))?.tags).toEqual([]);
  });

  it("does not create the tag for an org with nothing merged", async () => {
    // Runs against a second org so the earlier cases' tag can't mask it.
    const otherOrg = "org_mergedtag_2";
    const now = new Date().toISOString();
    await database.db
      .insertInto("organization")
      .values({
        id: otherOrg,
        name: otherOrg,
        slug: "org-mergedtag-2",
        createdAt: now,
      })
      .execute();
    const item = await taskBoard.create({
      organizationId: otherOrg,
      title: "nothing merged",
      status: "done",
      by: USER,
    });

    await tagMergedForOrg(ctx, otherOrg, [item.id], async () => false);

    expect(await tags.listOrgTags(otherOrg)).toEqual([]);
  });
});
