/**
 * Real-Postgres coverage for the sprint mirror, whose whole contract is a
 * constraint an in-memory fake would not enforce: `UNIQUE (organization_id,
 * jira_sprint_id)` is what makes the pull's upsert idempotent, and
 * `sprint_id`'s `ON DELETE SET NULL` is what decides whether deleting a sprint
 * sends its cards to the backlog or takes the work with it.
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

const ORG = "org_sprint_1";
const OTHER_ORG = "org_sprint_2";
const USER = "user_sp1";

describe("sprint mirror", () => {
  let database: StudioDatabase;
  let sprints: SprintStorage;
  let taskBoard: TaskBoardStorage;

  const jiraSprint = (overrides: Record<string, unknown> = {}) => ({
    jiraSprintId: "5",
    name: "Sprint 5",
    state: "active" as const,
    startsAt: new Date("2026-03-02T00:00:00.000Z"),
    endsAt: new Date("2026-03-15T00:00:00.000Z"),
    ...overrides,
  });

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const now = new Date().toISOString();
    for (const [id, slug] of [
      [ORG, "org-sprint-1"],
      [OTHER_ORG, "org-sprint-2"],
    ]) {
      await database.db
        .insertInto("organization")
        .values({ id: id!, name: id!, slug: slug!, createdAt: now })
        .execute();
    }
    // Raw SQL: real Postgres has a BOOLEAN emailVerified the typed shape disagrees with.
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${"sp1@sprint.test"}, false, ${USER}, ${now}, ${now})
    `.execute(database.db);
    sprints = new SprintStorage(database.db);
    taskBoard = new TaskBoardStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("upserts the same Jira sprint in place, however many runs see it", async () => {
    const first = await sprints.upsertFromJira(ORG, jiraSprint());
    const again = await sprints.upsertFromJira(ORG, jiraSprint());
    expect(again).toBe(first);
    expect(await sprints.listByOrg(ORG)).toHaveLength(1);
  });

  it("overwrites the fields Jira owns — a renamed or closed sprint reads that way", async () => {
    const id = await sprints.upsertFromJira(ORG, jiraSprint());
    await sprints.upsertFromJira(
      ORG,
      jiraSprint({ name: "Sprint 5 — hardening", state: "closed" }),
    );
    const mirrored = (await sprints.listByOrg(ORG)).find((s) => s.id === id);
    expect(mirrored?.name).toBe("Sprint 5 — hardening");
    expect(mirrored?.state).toBe("closed");
  });

  it("keeps two orgs mirroring the same Jira sprint id apart", async () => {
    const mine = await sprints.upsertFromJira(ORG, jiraSprint());
    const theirs = await sprints.upsertFromJira(OTHER_ORG, jiraSprint());
    expect(theirs).not.toBe(mine);
    expect(await sprints.listByOrg(OTHER_ORG)).toHaveLength(1);
  });

  it("returns dates as ISO instants, and a dateless sprint as nulls", async () => {
    const id = await sprints.upsertFromJira(
      ORG,
      jiraSprint({ jiraSprintId: "6", startsAt: null, endsAt: null }),
    );
    const listed = await sprints.listByOrg(ORG);
    expect(listed.find((s) => s.id === id)).toMatchObject({
      startsAt: null,
      endsAt: null,
    });
    const dated = listed.find((s) => s.name.startsWith("Sprint 5"));
    expect(dated?.startsAt).toBe("2026-03-02T00:00:00.000Z");
  });

  /** Ordering is a property of the whole list, so it gets the org the other
   *  cases don't write into. `Sprint 5` is the one this org already mirrors. */
  it("lists running sprints before planned ones, and history last", async () => {
    for (const [id, name, state] of [
      ["21", "Ran", "closed"],
      ["22", "Next", "future"],
      ["23", "Running", "active"],
    ] as const) {
      await sprints.upsertFromJira(
        OTHER_ORG,
        jiraSprint({ jiraSprintId: id, name, state }),
      );
    }
    expect((await sprints.listByOrg(OTHER_ORG)).map((s) => s.name)).toEqual([
      "Running",
      "Sprint 5",
      "Next",
      "Ran",
    ]);
  });

  it("sends a sprint's cards to the backlog when the sprint is deleted, keeping the work", async () => {
    const sprintId = await sprints.upsertFromJira(
      ORG,
      jiraSprint({ jiraSprintId: "9", name: "Sprint 9" }),
    );
    const card = await taskBoard.create({
      organizationId: ORG,
      title: "planned into a sprint",
      sprintId,
      by: USER,
    });
    expect(card.sprintId).toBe(sprintId);

    await sql`DELETE FROM task_board_sprints WHERE id = ${sprintId}`.execute(
      database.db,
    );
    const after = await taskBoard.getById(card.id, ORG);
    expect(after?.id).toBe(card.id);
    expect(after?.sprintId).toBe(null);
  });

  it("refuses a state outside Jira's three, rather than storing a lane it invented", async () => {
    await expect(
      sql`
        INSERT INTO task_board_sprints (id, organization_id, name, state)
        VALUES ('sprint_bad', ${ORG}, 'Bad', 'in_progress')
      `.execute(database.db),
    ).rejects.toThrow();
  });
});
