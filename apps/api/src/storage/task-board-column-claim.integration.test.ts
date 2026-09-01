/**
 * Real-Postgres coverage for the fence a column rule claims through.
 *
 * The rule lives on a column, so the claim has to be conditional on the card
 * still sitting in THAT column. It used to be conditional on the board's queue
 * lane instead, while the rule itself was looked up by the card's status — so
 * a rule on any other column found itself, tried to claim somewhere else,
 * matched nothing, and did nothing. Silently, because a lost claim and an
 * impossible one both come back null.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import { TaskBoardStorage } from "./task-board";

const ORG = "org_column_claim";
const USER = "user_column_claim";

describe("claimUnassignedForSuperAgent (real Postgres)", () => {
  let database: StudioDatabase;
  let taskBoard: TaskBoardStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await database.db
      .insertInto("organization")
      .values({
        id: ORG,
        name: ORG,
        slug: "org-column-claim",
        createdAt: new Date().toISOString(),
      })
      .execute();
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${"column-claim@test"}, false, ${USER}, ${now}, ${now})
    `.execute(database.db);
    taskBoard = new TaskBoardStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  const card = (status: string) =>
    taskBoard.create({
      organizationId: ORG,
      title: `card in ${status}`,
      status,
      by: USER,
    });

  /**
   * The bug. A tracker's column is called whatever it is called, and a team
   * putting its rule on "QA" is the normal case — not everything starts from
   * a queue lane.
   */
  it("claims a card in the column the rule is on, whatever it is called", async () => {
    const task = await card("QA Deco");
    const claimed = await taskBoard.claimUnassignedForSuperAgent(
      task.id,
      ORG,
      USER,
      USER,
      "QA Deco",
    );
    expect(claimed?.assigneeId).toBe(SUPER_AGENT_ASSIGNEE_ID);
    expect(claimed?.assignedBy).toBe(USER);
  });

  /** The card moved on between the read and the claim, so the rule that fired
   *  is no longer the rule for where it is. */
  it("refuses a card that has left that column", async () => {
    const task = await card("Fazendo");
    expect(
      await taskBoard.claimUnassignedForSuperAgent(
        task.id,
        ORG,
        USER,
        USER,
        "QA Deco",
      ),
    ).toBeNull();
  });

  /** What makes it a fence: exactly one of two concurrent triggers wins, so a
   *  card cannot buy two agent runs. */
  it("lets one of two concurrent triggers win, never both", async () => {
    const task = await card("Fazendo");
    const [a, b] = await Promise.all([
      taskBoard.claimUnassignedForSuperAgent(
        task.id,
        ORG,
        USER,
        USER,
        "Fazendo",
      ),
      taskBoard.claimUnassignedForSuperAgent(
        task.id,
        ORG,
        USER,
        USER,
        "Fazendo",
      ),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  /** A card someone already owns is theirs; a rule never takes it. */
  it("refuses a card that already has an assignee", async () => {
    const task = await card("Fazendo");
    await taskBoard.update(task.id, ORG, { assigneeId: USER }, USER);
    expect(
      await taskBoard.claimUnassignedForSuperAgent(
        task.id,
        ORG,
        USER,
        USER,
        "Fazendo",
      ),
    ).toBeNull();
  });

  /** Null is "this board has no such column", which cannot be claimed in. */
  it("refuses when the board has no column for the rule", async () => {
    const task = await card("Fazendo");
    expect(
      await taskBoard.claimUnassignedForSuperAgent(
        task.id,
        ORG,
        USER,
        USER,
        null,
      ),
    ).toBeNull();
  });
});
