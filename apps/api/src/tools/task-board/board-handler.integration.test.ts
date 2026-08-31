/**
 * The seam automation asks instead of comparing `status` to a literal.
 *
 * Real Postgres because the answer now comes from rows, and the property that
 * matters most is the absence of one: a column with no rule has to be
 * uneventful. A fake that returned a default would agree with a version that
 * runs an agent on every card that moves.
 */

import { sql } from "kysely";
import { TaskBoardStorage } from "@/storage/task-board";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { CANONICAL_COLUMN_KEYS } from "@decocms/shared/task-board";
import type { StudioDatabase } from "@/database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "@/database/test-db-pg";
import { ColumnAutomationStorage } from "@/storage/task-board-column-automations";
import { BoardColumnStorage } from "@/storage/task-board-columns";
import { boardHandler } from "./board-handler";
import { LANE_RANK } from "./lanes";

const ORG = "org_bh_1";
const OTHER = "org_bh_2";
const ORG_M = "org_bh_m";
const USER_M = "user_bh_m";

let database: StudioDatabase;
let automations: ColumnAutomationStorage;
let boardColumns: BoardColumnStorage;
let taskBoard: TaskBoardStorage;

/** One pool for the file. `connectTestPgDatabase` hands back a shared instance,
 *  so a per-describe lifecycle would close it out from under the next one. */
beforeAll(async () => {
  database = await connectTestPgDatabase();
  await resetTestPgDatabase(database);
  const now = new Date().toISOString();
  for (const id of [ORG, OTHER, ORG_M]) {
    await database.db
      .insertInto("organization")
      .values({ id, name: id, slug: id.replace(/_/g, "-"), createdAt: now })
      .execute();
  }
  await sql`
    INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
    VALUES (${USER_M}, ${"bhm@test.test"}, false, ${USER_M}, ${now}, ${now})
  `.execute(database.db);
  automations = new ColumnAutomationStorage(database.db);
  boardColumns = new BoardColumnStorage(database.db);
  taskBoard = new TaskBoardStorage(database.db);
});

afterAll(async () => {
  await closeTestPgDatabase(database);
});

describe("boardHandler — the board Studio ships with", () => {
  const board = (org = ORG) =>
    boardHandler(org, { automations, boardColumns, orgOwnedColumns: false });

  it("renders every canonical column, left to right", async () => {
    expect((await board().columns()).map((c) => c.key)).toEqual([
      ...CANONICAL_COLUMN_KEYS,
    ]);
  });

  /** Position and rank are one ordering read two ways; if they drift, a card
   *  is "left of" something and "right of" it at once. */
  it("orders columns the way the forward-only guard ranks them", async () => {
    for (const column of await board().columns()) {
      expect(column.position).toBe(
        LANE_RANK[column.key as keyof typeof LANE_RANK],
      );
    }
  });

  it("leaves a card unguarded, because its lanes are constants", () => {
    expect(board().columnOwner()).toBe(null);
  });

  it("retires a finished card to its Archived lane", async () => {
    expect(await board().archiveColumn()).toBe("archived");
  });

  it("does nothing on a board nobody has configured", async () => {
    for (const key of CANONICAL_COLUMN_KEYS) {
      expect(await board().automationFor(key)).toBe(null);
    }
  });

  it("runs the rule hung on a column, and only that column", async () => {
    await automations.upsert(ORG, "in_review", "Review this and report back.");
    expect(await board().automationFor("in_review")).toEqual({
      columnKey: "in_review",
      prompt: "Review this and report back.",
    });
    expect(await board().automationFor("todo")).toBe(null);
  });

  /** A rule carried over from `auto_delegate` has no instruction of its own —
   *  null has to keep meaning the Super Agent's built-in one. */
  it("keeps a rule with no instruction of its own", async () => {
    await automations.upsert(ORG, "todo", null);
    expect(await board().automationFor("todo")).toEqual({
      columnKey: "todo",
      prompt: null,
    });
  });

  it("replaces the instruction rather than adding a second rule", async () => {
    await automations.upsert(ORG, "todo", "First.");
    await automations.upsert(ORG, "todo", "Second.");
    expect((await board().automationFor("todo"))?.prompt).toBe("Second.");
    expect(
      (await automations.listByOrg(ORG)).filter((a) => a.columnKey === "todo"),
    ).toHaveLength(1);
  });

  it("turns the automation off by removing the rule", async () => {
    await automations.upsert(ORG, "done", "x");
    expect(await automations.remove(ORG, "done")).toBe(true);
    expect(await board().automationFor("done")).toBe(null);
    expect(await automations.remove(ORG, "done")).toBe(false);
  });

  it("is scoped to the org, so one tenant's rules cannot fire on another's board", async () => {
    await automations.upsert(ORG, "triage", "mine");
    expect(await board(OTHER).automationFor("triage")).toBe(null);
    expect(await automations.listByOrg(OTHER)).toEqual([]);
  });
});

/**
 * The second board, and the reason the interface exists.
 *
 * What matters is that it does NOT fall back to Studio's lanes. An org that
 * said its columns are its own gets its own — empty if that is what they are —
 * because falling back would quietly re-introduce a vocabulary it has opted
 * out of, and the cards would look filed under lanes nobody chose.
 */
describe("boardHandler — a board whose columns are the org's own", () => {
  const board = () =>
    boardHandler(ORG_M, { automations, boardColumns, orgOwnedColumns: true });

  it("renders nothing before its columns arrive, rather than Studio's lanes", async () => {
    expect(await board().columns()).toEqual([]);
  });

  it("renders the org's own columns, in the order given", async () => {
    await boardColumns.replaceAll(ORG_M, [
      { key: "BACKLOG", title: "Backlog", trackerStatuses: [] },
      { key: "Fazendo", title: "Em Progresso", trackerStatuses: [] },
      { key: "Code Review", title: "Code Review", trackerStatuses: [] },
    ]);
    expect((await board().columns()).map((c) => c.title)).toEqual([
      "Backlog",
      "Em Progresso",
      "Code Review",
    ]);
  });

  it("gives a mirrored column no role until someone says what it means", async () => {
    expect((await board().columns()).every((c) => c.role === null)).toBe(true);
    await boardColumns.setRole(ORG_M, "Code Review", "in_review");
    const named = (await board().columns()).find(
      (c) => c.key === "Code Review",
    );
    expect(named?.role).toBe("in_review");
  });

  /** A role is Studio's reading of someone else's column, so re-mirroring must
   *  not wipe it — the tracker has no idea it exists. */
  it("keeps a role through a re-sync, and drops a column that vanished", async () => {
    await boardColumns.replaceAll(ORG_M, [
      { key: "BACKLOG", title: "Backlog", trackerStatuses: [] },
      { key: "Code Review", title: "Code Review", trackerStatuses: [] },
    ]);
    const after = await board().columns();
    expect(after.map((c) => c.key)).toEqual(["BACKLOG", "Code Review"]);
    expect(after.find((c) => c.key === "Code Review")?.role).toBe("in_review");
  });

  /**
   * The reason `archiveColumn` is nullable. Studio's `archived` is a lane of
   * ours; a board mirrored from a tracker has no such column until someone
   * says which one means that, and writing our key into a card on that board
   * would file it under a column that does not exist.
   */
  it("has nowhere to retire a card until the org says which column that is", async () => {
    expect(await board().archiveColumn()).toBe(null);
    await boardColumns.setRole(ORG_M, "BACKLOG", "archived");
    expect(await board().archiveColumn()).toBe("BACKLOG");
    await boardColumns.setRole(ORG_M, "BACKLOG", null);
    expect(await board().archiveColumn()).toBe(null);
  });

  /** A role names one column. Re-pointing it must strip it from wherever it
   *  used to be, or `archiveColumn` picks between two columns that both
   *  quietly claim "archived" — whichever the query happens to return first. */
  it("moves a role rather than duplicating it onto a second column", async () => {
    await boardColumns.setRole(ORG_M, "BACKLOG", "archived");
    await boardColumns.setRole(ORG_M, "Code Review", "archived");
    const columns = await board().columns();
    expect(columns.filter((c) => c.role === "archived")).toHaveLength(1);
    expect(await board().archiveColumn()).toBe("Code Review");
  });

  /**
   * The obligation the foreign key creates. A column the tracker dropped that
   * still holds cards cannot be deleted — RESTRICT refuses — and moving those
   * cards somewhere Studio picked is a worse answer than showing a column the
   * tracker no longer has. It goes to the end and leaves on its own once empty.
   */
  it("keeps a dropped column that still holds cards, and drops it once empty", async () => {
    await boardColumns.replaceAll(ORG_M, [
      { key: "BACKLOG", title: "Backlog", trackerStatuses: [] },
      { key: "Retired", title: "Retired", trackerStatuses: [] },
    ]);
    const card = await taskBoard.create({
      organizationId: ORG_M,
      title: "left behind",
      status: "Retired",
      by: USER_M,
    });

    await boardColumns.replaceAll(ORG_M, [
      { key: "BACKLOG", title: "Backlog", trackerStatuses: [] },
    ]);
    expect((await board().columns()).map((c) => c.key)).toEqual([
      "BACKLOG",
      "Retired",
    ]);

    await taskBoard.update(card.id, ORG_M, { status: "BACKLOG" }, USER_M);
    await boardColumns.replaceAll(ORG_M, [
      { key: "BACKLOG", title: "Backlog", trackerStatuses: [] },
    ]);
    expect((await board().columns()).map((c) => c.key)).toEqual(["BACKLOG"]);
  });

  /**
   * The foreign key was paid for in #6710 and slept until something wrote the
   * discriminator. These pin that it is now awake for a card the sync placed,
   * and still asleep for one it has not — which is what makes adopting it
   * incremental instead of a flag day.
   */
  it("refuses a card in a column the board does not have, once guarded", async () => {
    await boardColumns.replaceAll(ORG_M, [
      { key: "BACKLOG", title: "Backlog", trackerStatuses: [] },
    ]);
    const guarded = taskBoard.create({
      organizationId: ORG_M,
      title: "guarded",
      status: "not_a_column",
      boardColumnOrg: ORG_M,
      by: USER_M,
    });
    await expect(guarded).rejects.toThrow(/foreign key|violates/i);
  });

  it("accepts the same card while it is still unguarded", async () => {
    const card = await taskBoard.create({
      organizationId: ORG_M,
      title: "unguarded",
      status: "not_a_column",
      by: USER_M,
    });
    expect(card.status).toBe("not_a_column");
  });

  /** The value every writer asks for instead of recomputing. Getting it from
   *  the board is what stops one path guarding a card and another not. */
  it("names itself as the owner a guarded card is held to", () => {
    expect(board().columnOwner()).toBe(ORG_M);
  });

  it("runs a rule hung on a column the tracker named", async () => {
    await automations.upsert(ORG_M, "Code Review", "Review it.");
    expect((await board().automationFor("Code Review"))?.prompt).toBe(
      "Review it.",
    );
    expect(await board().automationFor("todo")).toBe(null);
  });
});
