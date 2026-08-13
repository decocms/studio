/**
 * Real-Postgres coverage for the review sweeper's work list.
 *
 * This is the query that decides which stuck cards get rescued, so its
 * predicates are the contract: In Review only, dismissed cards excluded,
 * oldest-touched first so a long backlog drains fairly instead of starving the
 * cards that have been stuck longest, and bounded by `limit` so one tick can't
 * scan the world.
 *
 * Deliberately NOT filtered on assignee. It used to be Super Agent only, which
 * made every hand-off terminal: a card whose reviewers all approved but whose
 * merge failed was unassigned, vanished from this query and never merged again.
 * `reconcileItem` re-applies the assignee gate to everything except that merge
 * retry, so a handed-off card still burns no agent runs.
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

  // Approvals belong to the card, not to whoever holds it — an unassigned card
  // is precisely the one the merge retry exists for. `reconcileItem` is what
  // stops a reviewer being dispatched at either of these.
  it("keeps a card that is not the Super Agent's", async () => {
    const mine = await card({ org: ORG_A, title: "mine", assignee: USER });
    const nobodys = await card({
      org: ORG_A,
      title: "unassigned",
      assignee: null,
    });

    const ids = (await taskBoard.listItemsPendingReview(50)).map((p) => p.id);
    expect(ids).toContain(mine.id);
    expect(ids).toContain(nobodys.id);
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

  // The sweep budget that bounds the sweeper's GitHub cost. Before it, a card
  // whose checks never go green was re-fetched on every tick of every replica —
  // 4 `pull_request_read` calls x 32 cards x 3 pods / 60s = ~370 calls/min for 17
  // hours in prod, 93% of them answered 429 by GitHub. Real Postgres because the
  // whole mechanism is one NULL-aware SQL predicate plus one narrow UPDATE.
  describe("due filter (last_swept_at)", () => {
    const ORG_DUE = "org_pending_due";
    /** The cutoff a live tick passes: one interval ago. It must be in the PAST
     *  — a future cutoff re-claims a card this same tick already stamped. */
    const dueNow = () => new Date(Date.now() - 5 * 60_000);

    beforeAll(async () => {
      await database.db
        .insertInto("organization")
        .values({
          id: ORG_DUE,
          name: ORG_DUE,
          slug: "org-pending-due",
          createdAt: new Date().toISOString(),
        })
        .execute();
    });

    const sweptAt = async (id: string, iso: string) => {
      await database.db
        .updateTable("task_board_items")
        .set({ last_swept_at: iso })
        .where("id", "=", id)
        .execute();
    };

    const dueIds = async (dueBefore: Date) =>
      (await taskBoard.listItemsPendingReview(50, null, dueBefore))
        .filter((r) => r.organizationId === ORG_DUE)
        .map((r) => r.id);

    // A never-swept card must be due, or the filter would exclude every card
    // that existed before the column did and the sweeper would go permanently
    // idle after deploy.
    it("treats a never-swept card as due", async () => {
      const fresh = await card({ org: ORG_DUE, title: "never swept" });
      expect(await dueIds(new Date())).toContain(fresh.id);
    });

    it("excludes a card swept inside the interval and returns it once outside", async () => {
      const item = await card({ org: ORG_DUE, title: "recently swept" });
      await sweptAt(item.id, "2026-01-01T00:05:00.000Z");

      // Interval boundary just before the sweep — not due yet.
      expect(await dueIds(new Date("2026-01-01T00:00:00.000Z"))).not.toContain(
        item.id,
      );
      // Boundary past the sweep — due again.
      expect(await dueIds(new Date("2026-01-01T00:10:00.000Z"))).toContain(
        item.id,
      );
    });

    // This is the fix for the replica amplification: pod A's stamp is what makes
    // the card disappear from pod B's work list, so three pods cost what one
    // costs. Also asserts the stamp does NOT move `updated_at` — that column is
    // the keyset cursor and the UI's "edited" signal, and churning it on every
    // sweep would reorder the backlog under the cursor.
    it("claimSweep claims the interval without touching updated_at", async () => {
      const item = await card({ org: ORG_DUE, title: "claimed" });
      const before = await database.db
        .selectFrom("task_board_items")
        .select(["updated_at", "last_swept_at"])
        .where("id", "=", item.id)
        .executeTakeFirstOrThrow();
      expect(before.last_swept_at).toBeNull();

      expect(await taskBoard.claimSweep(item.id, ORG_DUE, dueNow())).toBe(true);

      const after = await database.db
        .selectFrom("task_board_items")
        .select(["updated_at", "last_swept_at"])
        .where("id", "=", item.id)
        .executeTakeFirstOrThrow();
      expect(after.last_swept_at).not.toBeNull();
      expect(new Date(after.updated_at).toISOString()).toBe(
        new Date(before.updated_at).toISOString(),
      );
      // And the freshly-stamped card is no longer due this interval.
      expect(await dueIds(new Date(Date.now() - 60_000))).not.toContain(
        item.id,
      );
    });

    // Org-scoped like every other write here: a task id alone must not let one
    // org's sweep stamp another org's card.
    it("claimSweep will not stamp a card from another org", async () => {
      const item = await card({ org: ORG_DUE, title: "other org" });
      expect(await taskBoard.claimSweep(item.id, ORG_A, dueNow())).toBe(false);

      const row = await database.db
        .selectFrom("task_board_items")
        .select("last_swept_at")
        .where("id", "=", item.id)
        .executeTakeFirstOrThrow();
      expect(row.last_swept_at).toBeNull();
    });

    // The reason this is a claim and not a stamp. Every replica reads the same
    // work list in the same second, and an unconditional write let all of them
    // through to the GitHub calls that follow: two `merge_pull_request` calls
    // landed on one PR inside a second, the loser answered "405 Merge already
    // in progress" and recorded as a merge failure on the card's timeline.
    it("a second replica in the same round loses the claim", async () => {
      const item = await card({ org: ORG_DUE, title: "contended" });

      const cutoff = dueNow();
      expect(await taskBoard.claimSweep(item.id, ORG_DUE, cutoff)).toBe(true);
      expect(await taskBoard.claimSweep(item.id, ORG_DUE, cutoff)).toBe(false);
    });

    it("the card is claimable again once its interval has passed", async () => {
      const item = await card({ org: ORG_DUE, title: "next round" });
      await sweptAt(item.id, "2026-01-01T00:05:00.000Z");

      // Same boundary the work list uses: swept at :05, so a tick whose cutoff
      // is :00 must not re-claim it, and one at :10 must.
      expect(
        await taskBoard.claimSweep(
          item.id,
          ORG_DUE,
          new Date("2026-01-01T00:00:00.000Z"),
        ),
      ).toBe(false);
      expect(
        await taskBoard.claimSweep(
          item.id,
          ORG_DUE,
          new Date("2026-01-01T00:10:00.000Z"),
        ),
      ).toBe(true);
    });
  });
});
