/**
 * The seam automation asks instead of comparing `status` to a literal.
 *
 * Real Postgres because the answer now comes from rows, and the property that
 * matters most is the absence of one: a column with no rule has to be
 * uneventful. A fake that returned a default would agree with a version that
 * runs an agent on every card that moves.
 */

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

describe("boardHandler — the board Studio ships with", () => {
  let database: StudioDatabase;
  let automations: ColumnAutomationStorage;
  let boardColumns: BoardColumnStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const now = new Date().toISOString();
    for (const id of [ORG, OTHER]) {
      await database.db
        .insertInto("organization")
        .values({ id, name: id, slug: id.replace(/_/g, "-"), createdAt: now })
        .execute();
    }
    automations = new ColumnAutomationStorage(database.db);
    boardColumns = new BoardColumnStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

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
  let database: StudioDatabase;
  let automations: ColumnAutomationStorage;
  let boardColumns: BoardColumnStorage;
  const ORG_M = "org_bh_m";

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    const now = new Date().toISOString();
    await database.db
      .insertInto("organization")
      .values({ id: ORG_M, name: ORG_M, slug: "org-bh-m", createdAt: now })
      .execute();
    automations = new ColumnAutomationStorage(database.db);
    boardColumns = new BoardColumnStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  const board = () =>
    boardHandler(ORG_M, { automations, boardColumns, orgOwnedColumns: true });

  it("renders nothing before its columns arrive, rather than Studio's lanes", async () => {
    expect(await board().columns()).toEqual([]);
  });

  it("renders the org's own columns, in the order given", async () => {
    await boardColumns.replaceAll(ORG_M, [
      { key: "BACKLOG", title: "Backlog" },
      { key: "Fazendo", title: "Em Progresso" },
      { key: "Code Review", title: "Code Review" },
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
      { key: "BACKLOG", title: "Backlog" },
      { key: "Code Review", title: "Code Review" },
    ]);
    const after = await board().columns();
    expect(after.map((c) => c.key)).toEqual(["BACKLOG", "Code Review"]);
    expect(after.find((c) => c.key === "Code Review")?.role).toBe("in_review");
  });

  it("runs a rule hung on a column the tracker named", async () => {
    await automations.upsert(ORG_M, "Code Review", "Review it.");
    expect((await board().automationFor("Code Review"))?.prompt).toBe(
      "Review it.",
    );
    expect(await board().automationFor("todo")).toBe(null);
  });
});
