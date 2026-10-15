/**
 * Migration 238 puts every card and column rule where the new board reads it.
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
import { up as up238 } from "./238-task-board-default-lanes";
import {
  down as restoreRuleTables,
  up as dropRuleTables,
} from "./248-drop-retired-rule-tables";

const ORG = "org_test";

describe("migration 238 — task board default lanes", () => {
  let database: StudioDatabase;
  let storage: TaskBoardStorage;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await restoreRuleTables(database.db as any);
    storage = new TaskBoardStorage(database.db);
  });

  afterEach(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await dropRuleTables(database.db as any);
    await closeTestPgDatabase(database);
  });

  // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
  const migrate = () => up238(database.db as any);

  /** A card written straight to the table, the way the previous release left it. */
  async function card(
    status: string,
    opts: { cycle?: boolean } = {},
  ): Promise<string> {
    const item = await storage.create({
      organizationId: ORG,
      title: `card in ${status}`,
      by: "user_test",
    });
    await sql`
      update task_board_items
         set status = ${status},
             review_cycle_started_at = ${opts.cycle ? new Date() : null}
       where id = ${item.id}
    `.execute(database.db);
    return item.id;
  }

  async function statusOf(id: string): Promise<string | undefined> {
    return (await storage.getById(id, ORG))?.status;
  }

  it("moves cards off the previous board's lanes and logs each move", async () => {
    const todo = await card("todo");
    const reviewing = await card("in_progress", { cycle: true });
    const working = await card("in_progress");
    const handedOver = await card("in_review", { cycle: true });
    const approved = await card("approved");
    const merged = await card("merged");
    const done = await card("done");

    await migrate();

    expect(await statusOf(todo)).toBe("triage");
    expect(await statusOf(reviewing)).toBe("in_review");
    expect(await statusOf(working)).toBe("in_progress");
    expect(await statusOf(handedOver)).toBe("in_review");
    expect(await statusOf(approved)).toBe("ready_for_deployment");
    expect(await statusOf(merged)).toBe("post_deploy_validation");
    expect(await statusOf(done)).toBe("done");

    const moves = await storage.listActivity(todo, ORG);
    expect(moves.at(-1)).toMatchObject({
      action: "status_changed",
      actorId: null,
      data: { from: "todo", to: "triage", reason: "board_lanes" },
    });
    // Only the cards that moved get an entry.
    const untouched = await storage.listActivity(working, ORG);
    expect(untouched.filter((a) => a.action === "status_changed")).toHaveLength(
      0,
    );
  });

  it("moves the reviewer's and the implementer's instructions to their lanes", async () => {
    await sql`
      insert into task_board_prompts (id, organization_id, column_key, prompt, skills)
      values
        (${`tbp_${ORG}_todo`}, ${ORG}, 'todo', 'implement carefully', '{core/a}'),
        (${`tbp_${ORG}_in_progress`}, ${ORG}, 'in_progress', 'review carefully', '{core/b}'),
        (${`tbp_${ORG}_`}, ${ORG}, null, 'board-wide', '{}')
    `.execute(database.db);

    await migrate();

    const rows = await sql<{
      id: string;
      column_key: string | null;
      prompt: string;
    }>`
      select id, column_key, prompt from task_board_prompts
       where organization_id = ${ORG} order by column_key nulls first
    `.execute(database.db);
    expect(rows.rows).toEqual([
      { id: `tbp_${ORG}_`, column_key: null, prompt: "board-wide" },
      {
        id: `tbp_${ORG}_in_progress`,
        column_key: "in_progress",
        prompt: "implement carefully",
      },
      {
        id: `tbp_${ORG}_in_review`,
        column_key: "in_review",
        prompt: "review carefully",
      },
    ]);
  });

  it("keeps an org's own In Review instructions over the old reviewer rule", async () => {
    await sql`
      insert into task_board_prompts (id, organization_id, column_key, prompt, skills)
      values
        (${`tbp_${ORG}_in_progress`}, ${ORG}, 'in_progress', 'default reviewer', '{}'),
        (${`tbp_${ORG}_in_review`}, ${ORG}, 'in_review', 'our reviewer', '{}')
    `.execute(database.db);

    await migrate();

    const rows = await sql<{ column_key: string; prompt: string }>`
      select column_key, prompt from task_board_prompts
       where organization_id = ${ORG} order by column_key
    `.execute(database.db);
    expect(rows.rows).toEqual([
      { column_key: "in_review", prompt: "our reviewer" },
    ]);
  });

  it("moves the To Do agent rule to In Progress and drops one on In Review", async () => {
    await sql`
      insert into task_board_column_automations (id, organization_id, column_key, prompt)
      values
        (${`tbca_${ORG}_todo`}, ${ORG}, 'todo', 'triage it'),
        (${`tbca_${ORG}_in_review`}, ${ORG}, 'in_review', null),
        (${`tbca_${ORG}_approved`}, ${ORG}, 'approved', 'release notes')
    `.execute(database.db);

    await migrate();

    const rows = await sql<{
      id: string;
      column_key: string;
      prompt: string | null;
    }>`
      select id, column_key, prompt from task_board_column_automations
       where organization_id = ${ORG} order by column_key
    `.execute(database.db);
    expect(rows.rows).toEqual([
      {
        id: `tbca_${ORG}_in_progress`,
        column_key: "in_progress",
        prompt: "triage it",
      },
      {
        id: `tbca_${ORG}_ready_for_deployment`,
        column_key: "ready_for_deployment",
        prompt: "release notes",
      },
    ]);
  });

  it("is a no-op on a second run", async () => {
    const todo = await card("todo");
    await migrate();
    await migrate();
    expect(await statusOf(todo)).toBe("triage");
    const moves = (await storage.listActivity(todo, ORG)).filter(
      (a) => a.action === "status_changed",
    );
    expect(moves).toHaveLength(1);
  });
});
