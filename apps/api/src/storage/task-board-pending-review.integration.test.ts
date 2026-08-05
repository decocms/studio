/**
 * Real-Postgres coverage for the review sweeper's work list.
 *
 * This is the query that decides which stuck cards get rescued, so its
 * predicates are the contract: Super Agent only (a human's card is not the
 * sweeper's business), In Review only, dismissed cards excluded, oldest-touched
 * first so a long backlog drains fairly instead of starving the cards that have
 * been stuck longest, and bounded by `limit` so one tick can't scan the world.
 *
 * Cross-org on purpose — the sweeper is a process-level reconciler with no
 * request org — which is exactly the kind of thing an in-memory fake would get
 * wrong, hence real Postgres.
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

const ORG_A = "org_pending_a";
const ORG_B = "org_pending_b";
const USER = "user_pending_review";
const SUPER_AGENT = "super-agent";

describe("listItemsPendingReview (real Postgres)", () => {
  let database: StudioDatabase;
  let taskBoard: TaskBoardStorage;

  const card = async (opts: {
    org: string;
    title: string;
    status?: "in_review" | "in_progress" | "done";
    assignee?: string | null;
    dismissed?: boolean;
  }) => {
    const item = await taskBoard.create({
      organizationId: opts.org,
      title: opts.title,
      status: opts.status ?? "in_review",
      assigneeId: opts.assignee === undefined ? SUPER_AGENT : opts.assignee,
      by: USER,
    });
    if (opts.dismissed) {
      await database.db
        .updateTable("task_board_items")
        .set({ dismissed_at: new Date().toISOString() })
        .where("id", "=", item.id)
        .execute();
    }
    return item;
  };

  /** Force a deterministic ordering key — `updated_at` drives the sweep order. */
  const touchedAt = async (id: string, iso: string) => {
    await database.db
      .updateTable("task_board_items")
      .set({ updated_at: iso })
      .where("id", "=", id)
      .execute();
  };

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    for (const [id, slug] of [
      [ORG_A, "org-pending-a"],
      [ORG_B, "org-pending-b"],
    ] as const) {
      await database.db
        .insertInto("organization")
        .values({
          id,
          name: id,
          slug,
          createdAt: new Date().toISOString(),
        })
        .execute();
    }
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${"pending@review.test"}, false, ${USER}, ${now}, ${now})
    `.execute(database.db);
    taskBoard = new TaskBoardStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("returns Super Agent cards In Review, across orgs, each carrying its own org", async () => {
    const a = await card({ org: ORG_A, title: "in review A" });
    const b = await card({ org: ORG_B, title: "in review B" });

    const pending = await taskBoard.listItemsPendingReview(50);
    const ids = pending.map((p) => p.id);

    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(pending.find((p) => p.id === a.id)?.organizationId).toBe(ORG_A);
    expect(pending.find((p) => p.id === b.id)?.organizationId).toBe(ORG_B);
  });

  it("skips cards that are not In Review", async () => {
    const running = await card({
      org: ORG_A,
      title: "still running",
      status: "in_progress",
    });
    const shipped = await card({
      org: ORG_A,
      title: "shipped",
      status: "done",
    });

    const ids = (await taskBoard.listItemsPendingReview(50)).map((p) => p.id);
    expect(ids).not.toContain(running.id);
    expect(ids).not.toContain(shipped.id);
  });

  // A human's card in review is a human's business — dispatching a reviewer at
  // it would burn a run nobody asked for.
  it("skips a card that is not the Super Agent's", async () => {
    const mine = await card({ org: ORG_A, title: "mine", assignee: USER });
    const nobodys = await card({
      org: ORG_A,
      title: "unassigned",
      assignee: null,
    });

    const ids = (await taskBoard.listItemsPendingReview(50)).map((p) => p.id);
    expect(ids).not.toContain(mine.id);
    expect(ids).not.toContain(nobodys.id);
  });

  it("skips a dismissed card", async () => {
    const gone = await card({
      org: ORG_A,
      title: "dismissed",
      dismissed: true,
    });

    const ids = (await taskBoard.listItemsPendingReview(50)).map((p) => p.id);
    expect(ids).not.toContain(gone.id);
  });

  it("returns the oldest-touched first, so a backlog cannot starve", async () => {
    const older = await card({ org: ORG_A, title: "stuck for days" });
    const newer = await card({ org: ORG_A, title: "just landed" });
    await touchedAt(older.id, "2020-01-01T00:00:00.000Z");
    await touchedAt(newer.id, "2030-01-01T00:00:00.000Z");

    const ids = (await taskBoard.listItemsPendingReview(50)).map((p) => p.id);
    expect(ids.indexOf(older.id)).toBeLessThan(ids.indexOf(newer.id));
  });

  it("honours the batch limit", async () => {
    expect(await taskBoard.listItemsPendingReview(2)).toHaveLength(2);
  });

  // The cursor is what stops a card the sweeper can NEVER rescue (In Review with
  // no PR — a research task) from permanently occupying a slot in a fixed
  // window: it is never touched, so it keeps its old `updated_at`, and once
  // `limit` of them accumulate nothing behind them is ever swept again.
  describe("keyset cursor", () => {
    it("pages through the whole backlog without repeating or skipping", async () => {
      // A fresh org so this test owns the full result set.
      const org = "org_pending_cursor";
      await database.db
        .insertInto("organization")
        .values({
          id: org,
          name: org,
          slug: "org-pending-cursor",
          createdAt: new Date().toISOString(),
        })
        .execute();
      const made: string[] = [];
      for (let i = 0; i < 7; i++) {
        const item = await card({ org, title: `card ${i}` });
        await touchedAt(item.id, `2021-01-0${i + 1}T00:00:00.000Z`);
        made.push(item.id);
      }

      const seen: string[] = [];
      let cursor: { updatedAt: string; id: string } | null = null;
      for (let page = 0; page < 5; page++) {
        // Annotated because `cursor` is derived from `rows` — without it the
        // inference is circular.
        const rows: {
          id: string;
          organizationId: string;
          updatedAt: string;
        }[] = (await taskBoard.listItemsPendingReview(3, cursor)).filter(
          (r) => r.organizationId === org,
        );
        if (rows.length === 0) break;
        seen.push(...rows.map((r) => r.id));
        const last = rows.at(-1)!;
        cursor = { updatedAt: last.updatedAt, id: last.id };
      }

      expect(seen).toEqual(made);
      expect(new Set(seen).size).toBe(made.length);
    });

    // Same `updated_at` to the millisecond: without the `id` tie-break the
    // cursor is not total and rows are skipped or repeated forever.
    it("is total when several cards share an updated_at", async () => {
      const org = "org_pending_tie";
      await database.db
        .insertInto("organization")
        .values({
          id: org,
          name: org,
          slug: "org-pending-tie",
          createdAt: new Date().toISOString(),
        })
        .execute();
      // Earlier than every other card this suite made, so the global ordering
      // puts all four at the front — paging is global (the sweeper has no org),
      // so filtering by org AFTER a limited page would just return nothing.
      const sameInstant = "1990-01-01T00:00:00.000Z";
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        const item = await card({ org, title: `tie ${i}` });
        await touchedAt(item.id, sameInstant);
        ids.push(item.id);
      }

      const first = await taskBoard.listItemsPendingReview(2, null);
      const last = first.at(-1)!;
      const second = await taskBoard.listItemsPendingReview(2, {
        updatedAt: last.updatedAt,
        id: last.id,
      });

      const seen = [...first, ...second].map((r) => r.id);
      // All four came back exactly once — no skip, no repeat, despite sharing
      // `updated_at` to the millisecond.
      expect(new Set(seen).size).toBe(4);
      expect(seen.slice().sort()).toEqual(ids.slice().sort());
    });
  });
});
