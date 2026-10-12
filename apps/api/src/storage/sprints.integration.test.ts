/**
 * Real-Postgres coverage for sprints. The contracts here live in SQL: the
 * state compare-and-sets, the carry-over UPDATE inside the completion's
 * transaction, `sprint_id`'s `ON DELETE SET NULL`, the date CHECK, and the
 * `to_char` that keeps a `date` from shifting through a JS `Date`.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import { SprintStorage } from "./sprints";
import { TaskBoardStorage } from "./task-board";

const ORG = "org_sprints_1";
const OTHER_ORG = "org_sprints_2";
const USER = "user_sprints";

describe("SprintStorage", () => {
  let database: StudioDatabase;
  let sprints: SprintStorage;
  let taskBoard: TaskBoardStorage;

  const sprint = (
    organizationId: string,
    name: string,
    days: { startDate?: string | null; endDate?: string | null } = {},
  ) =>
    sprints.create({
      organizationId,
      name,
      startDate: days.startDate ?? null,
      endDate: days.endDate ?? null,
      by: USER,
    });

  const card = (
    organizationId: string,
    status: string,
    sprintId: string | null,
  ) =>
    taskBoard.create({
      organizationId,
      title: `${status} card`,
      status,
      sprintId,
      by: USER,
    });

  const sprintOf = async (organizationId: string, itemId: string) =>
    (await taskBoard.getById(itemId, organizationId))?.sprintId;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${`${USER}@test.com`}, false, 'Sprints', ${now}, ${now})
    `.execute(database.db);
    for (const [id, slug] of [
      [ORG, "sprints-one"],
      [OTHER_ORG, "sprints-two"],
    ] as const) {
      await database.db
        .insertInto("organization")
        .values({ id, name: id, slug, createdAt: now })
        .execute();
    }
    sprints = new SprintStorage(database.db);
    taskBoard = new TaskBoardStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("reads calendar days back exactly as written", async () => {
    const created = await sprint(ORG, "Dated", {
      startDate: "2026-03-02",
      endDate: "2026-03-15",
    });
    expect(created).toMatchObject({
      state: "future",
      startDate: "2026-03-02",
      endDate: "2026-03-15",
    });
    expect(await sprints.get(ORG, created.id)).toEqual(created);
  });

  it("refuses an end day before the start day", async () => {
    await expect(
      sprint(ORG, "Backwards", {
        startDate: "2026-03-15",
        endDate: "2026-03-02",
      }),
    ).rejects.toThrow();
  });

  it("keeps each org's sprints to itself", async () => {
    const mine = await sprint(ORG, "Mine");
    const theirs = await sprint(OTHER_ORG, "Theirs");
    const listed = (await sprints.listByOrg(OTHER_ORG)).map((s) => s.id);
    expect(listed).toContain(theirs.id);
    expect(listed).not.toContain(mine.id);
    expect(await sprints.get(OTHER_ORG, mine.id)).toBeNull();
    expect(await sprints.update(OTHER_ORG, mine.id, { name: "x" })).toBeNull();
    expect(await sprints.start(OTHER_ORG, mine.id)).toBeNull();
    expect(await sprints.delete(OTHER_ORG, mine.id)).toBeNull();
    expect((await sprints.get(ORG, mine.id))?.name).toBe("Mine");
  });

  it("starts a planned sprint once", async () => {
    const planned = await sprint(ORG, "Start once");
    expect((await sprints.start(ORG, planned.id))?.state).toBe("active");
    expect(await sprints.start(ORG, planned.id)).toBeNull();
  });

  it("clears a date with null and leaves omitted fields alone", async () => {
    const dated = await sprint(ORG, "Re-date", {
      startDate: "2026-04-01",
      endDate: "2026-04-14",
    });
    const updated = await sprints.update(ORG, dated.id, { endDate: null });
    expect(updated).toMatchObject({
      name: "Re-date",
      startDate: "2026-04-01",
      endDate: null,
    });
  });

  it("completes a sprint by moving only its unfinished cards on", async () => {
    const running = await sprint(ORG, "Running");
    const next = await sprint(ORG, "Next");
    await sprints.start(ORG, running.id);
    const todo = await card(ORG, "todo", running.id);
    const review = await card(ORG, "in_review", running.id);
    const done = await card(ORG, "done", running.id);
    const archived = await card(ORG, "archived", running.id);
    const elsewhere = await card(ORG, "todo", next.id);

    const completion = await sprints.complete({
      organizationId: ORG,
      id: running.id,
      moveTo: next.id,
      by: USER,
    });

    expect(completion?.sprint.state).toBe("closed");
    expect(completion?.movedTo).toBe(next.id);
    expect([...(completion?.movedItemIds ?? [])].sort()).toEqual(
      [todo.id, review.id].sort(),
    );
    expect(await sprintOf(ORG, todo.id)).toBe(next.id);
    expect(await sprintOf(ORG, review.id)).toBe(next.id);
    expect(await sprintOf(ORG, done.id)).toBe(running.id);
    expect(await sprintOf(ORG, archived.id)).toBe(running.id);
    expect(await sprintOf(ORG, elsewhere.id)).toBe(next.id);

    expect(
      await sprints.complete({
        organizationId: ORG,
        id: running.id,
        moveTo: next.id,
        by: USER,
      }),
    ).toBeNull();
  });

  it("completes into the backlog", async () => {
    const running = await sprint(ORG, "To backlog");
    await sprints.start(ORG, running.id);
    const todo = await card(ORG, "todo", running.id);
    const completion = await sprints.complete({
      organizationId: ORG,
      id: running.id,
      moveTo: null,
      by: USER,
    });
    expect(completion?.movedItemIds).toEqual([todo.id]);
    expect(await sprintOf(ORG, todo.id)).toBeNull();
  });

  it("refuses a planned sprint, and writes nothing for a bad destination", async () => {
    const planned = await sprint(ORG, "Not started");
    expect(
      await sprints.complete({
        organizationId: ORG,
        id: planned.id,
        moveTo: null,
        by: USER,
      }),
    ).toBeNull();

    const running = await sprint(ORG, "Bad destination");
    await sprints.start(ORG, running.id);
    const todo = await card(ORG, "todo", running.id);
    const closed = await sprint(ORG, "Already closed");
    await sprints.start(ORG, closed.id);
    await sprints.complete({
      organizationId: ORG,
      id: closed.id,
      moveTo: null,
      by: USER,
    });
    const otherOrgs = await sprint(OTHER_ORG, "Other org's");

    for (const moveTo of [closed.id, otherOrgs.id, "sprint_missing"]) {
      await expect(
        sprints.complete({
          organizationId: ORG,
          id: running.id,
          moveTo,
          by: USER,
        }),
      ).rejects.toThrow("moveTo is not an open sprint");
      expect((await sprints.get(ORG, running.id))?.state).toBe("active");
      expect(await sprintOf(ORG, todo.id)).toBe(running.id);
    }
  });

  it("deletes a sprint and sends all of its cards to the backlog", async () => {
    const doomed = await sprint(ORG, "Doomed");
    const todo = await card(ORG, "todo", doomed.id);
    const done = await card(ORG, "done", doomed.id);
    const removed = await sprints.delete(ORG, doomed.id);
    expect(removed?.sprint.id).toBe(doomed.id);
    expect([...(removed?.movedItemIds ?? [])].sort()).toEqual(
      [todo.id, done.id].sort(),
    );
    expect(await sprintOf(ORG, todo.id)).toBeNull();
    expect(await sprintOf(ORG, done.id)).toBeNull();
    expect(await sprints.get(ORG, doomed.id)).toBeNull();
  });

  it("moves a card between sprints through the item update", async () => {
    const a = await sprint(ORG, "A");
    const b = await sprint(ORG, "B");
    const item = await card(ORG, "todo", a.id);
    expect(item.sprintId).toBe(a.id);
    const moved = await taskBoard.update(
      item.id,
      ORG,
      { sprintId: b.id },
      USER,
    );
    expect(moved.sprintId).toBe(b.id);
    const untouched = await taskBoard.update(
      item.id,
      ORG,
      { title: "t" },
      USER,
    );
    expect(untouched.sprintId).toBe(b.id);
    const backlog = await taskBoard.update(
      item.id,
      ORG,
      { sprintId: null },
      USER,
    );
    expect(backlog.sprintId).toBeNull();
  });
});
