/**
 * Migration 239 moves what the previous release left in the old lanes.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../src/database/test-db-pg";
import type { StudioDatabase } from "../src/database";
import { TaskBoardStorage } from "../src/storage/task-board";
import { up as up239 } from "./239-task-board-retire-old-lanes";

const ORG = "org_test";

describe("migration 239 — retire the old lanes", () => {
  let database: StudioDatabase;
  let storage: TaskBoardStorage;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    storage = new TaskBoardStorage(database.db);
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
  });

  // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
  const migrate = () => up239(database.db as any);

  async function card(status: string): Promise<string> {
    const item = await storage.create({
      organizationId: ORG,
      title: `card in ${status}`,
      by: "user_test",
    });
    await sql`update task_board_items set status = ${status} where id = ${item.id}`.execute(
      database.db,
    );
    return item.id;
  }

  it("moves straggler cards and logs each move", async () => {
    const todo = await card("todo");
    const approved = await card("approved");
    const merged = await card("merged");
    const working = await card("in_progress");

    await migrate();

    const status = async (id: string) =>
      (await storage.getById(id, ORG))?.status;
    expect(await status(todo)).toBe("triage");
    expect(await status(approved)).toBe("ready_for_deployment");
    expect(await status(merged)).toBe("post_deploy_validation");
    expect(await status(working)).toBe("in_progress");
    const entries = await storage.listActivity(approved, ORG);
    expect(entries.at(-1)).toMatchObject({
      action: "status_changed",
      actorId: null,
      data: { from: "approved", to: "ready_for_deployment" },
    });
  });

  it("moves rules on the old columns, keeping a rule already on the destination", async () => {
    await sql`
      insert into task_board_prompts (id, organization_id, column_key, prompt, skills)
      values
        (${`tbp_${ORG}_todo`}, ${ORG}, 'todo', 'from the old board', '{}'),
        (${`tbp_${ORG}_merged`}, ${ORG}, 'merged', 'validate it', '{}'),
        (${`tbp_${ORG}_post_deploy_validation`}, ${ORG}, 'post_deploy_validation', 'already here', '{}')
    `.execute(database.db);
    await sql`
      insert into task_board_column_automations (id, organization_id, column_key, prompt)
      values (${`tbca_${ORG}_approved`}, ${ORG}, 'approved', 'release notes')
    `.execute(database.db);

    await migrate();

    const prompts = await sql<{ column_key: string; prompt: string }>`
      select column_key, prompt from task_board_prompts
       where organization_id = ${ORG} order by column_key
    `.execute(database.db);
    expect(prompts.rows).toEqual([
      { column_key: "in_progress", prompt: "from the old board" },
      { column_key: "post_deploy_validation", prompt: "already here" },
    ]);
    const automations = await sql<{ id: string; column_key: string }>`
      select id, column_key from task_board_column_automations
       where organization_id = ${ORG}
    `.execute(database.db);
    expect(automations.rows).toEqual([
      {
        id: `tbca_${ORG}_ready_for_deployment`,
        column_key: "ready_for_deployment",
      },
    ]);
  });
});
