/**
 * Real-Postgres coverage for the task board operation report and project
 * scoping: the funnel's nested stages, what counts as a person stepping in
 * (only after the first run), and which cards a project owns.
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
import {
  type AnalyticsQuery,
  type Section,
  TaskBoardAnalyticsStorage,
} from "./task-board-analytics";
import { SqlThreadStorage } from "./threads";

const ORG = "org_board_analytics_a";
const OTHER_ORG = "org_board_analytics_b";
const USER = "user_board_analytics";
const PROJECT = "vir_board_analytics";
const PROJECT_REPO = "acme/shop";

const stat = (sections: Section[], label: string) =>
  sections
    .flatMap((s) => (s.kind === "stat" ? s.values : []))
    .find((v) => v.label === label);

const funnel = (sections: Section[]) => {
  const s = sections.find((x) => x.kind === "funnel");
  if (s?.kind !== "funnel") throw new Error("no funnel");
  return s.stages.map((st) => st.value);
};

const bars = (sections: Section[]) => {
  const s = sections.find((x) => x.kind === "bars");
  if (s?.kind !== "bars") throw new Error("no bars");
  return Object.fromEntries(s.bars.map((b) => [b.label, b.value]));
};

const tableRows = (sections: Section[], title: string) => {
  const s = sections.find((x) => x.kind === "table" && x.title === title);
  if (s?.kind !== "table") throw new Error(`no table ${title}`);
  return s.rows.map((r) =>
    Object.fromEntries(s.columns.map((c, i) => [c, r[i]])),
  );
};

describe("TaskBoardAnalyticsStorage.operation (real Postgres)", () => {
  let database: StudioDatabase;
  let analytics: TaskBoardAnalyticsStorage;
  let threads: SqlThreadStorage;
  let board: TaskBoardStorage;

  const base = Date.now() - 6 * 3600_000;
  const at = (minutes: number) =>
    new Date(base + minutes * 60_000).toISOString();

  const range = (): Omit<AnalyticsQuery, "orgIds"> => ({
    from: new Date(base - 3600_000).toISOString(),
    to: new Date(Date.now() + 3600_000).toISOString(),
  });

  const act = (
    item: string,
    action: string,
    actorId: string | null,
    minutes: number,
    data: Record<string, unknown> = {},
  ) =>
    sql`
      INSERT INTO task_board_activity (id, task_board_item_id, action, actor_id, data, occurred_at)
      VALUES (${crypto.randomUUID()}, ${item}, ${action}, ${actorId}, ${JSON.stringify(data)}, ${at(minutes)})
    `.execute(database.db);

  /** A run on `item`, started `minutes` in; `failed` with no kind is an error. */
  const run = async (
    org: string,
    item: string,
    minutes: number,
    opts: { project?: string; failed?: boolean } = {},
  ) => {
    const thread = await threads.create({
      organization_id: org,
      title: "run",
      status: opts.failed ? "failed" : "completed",
      message_storage_version: 2,
      created_by: USER,
      virtual_mcp_id: opts.project ?? "",
    });
    await sql`
      INSERT INTO task_board_item_threads (task_board_item_id, thread_id, organization_id, created_at)
      VALUES (${item}, ${thread.id}, ${org}, ${at(minutes)})
    `.execute(database.db);
  };

  const card = async (org: string, repo: string) =>
    (
      await board.create({
        organizationId: org,
        title: `card ${repo}`,
        status: "in_review",
        repo,
        by: USER,
      })
    ).id;

  let sentBack = "";

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    for (const [id, slug] of [
      [ORG, "board-analytics-a"],
      [OTHER_ORG, "board-analytics-b"],
    ] as const) {
      await database.db
        .insertInto("organization")
        .values({ id, name: id, slug, createdAt: new Date().toISOString() })
        .execute();
    }
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${"analytics@board.test"}, false, ${USER}, ${now}, ${now})
    `.execute(database.db);
    analytics = new TaskBoardAnalyticsStorage(database.db);
    threads = new SqlThreadStorage(database.db);
    board = new TaskBoardStorage(database.db);

    // Shipped untouched; queueing it before the run is not stepping in.
    const clean = await card(ORG, PROJECT_REPO);
    await act(clean, "assignee_changed", USER, 0, { to: "super-agent" });
    await run(ORG, clean, 5);
    await act(clean, "review_approved", null, 60);
    await act(clean, "status_changed", null, 90, {
      from: "in_review",
      to: "done",
    });

    // Sent back by the reviewer, re-run and commented on by a person, shipped.
    sentBack = await card(ORG, "ACME/Shop");
    await run(ORG, sentBack, 5);
    await act(sentBack, "review_changes_requested", null, 60);
    await board.createComment({
      taskBoardItemId: sentBack,
      organizationId: ORG,
      authorId: USER,
      body: "please fix mobile",
    });
    await sql`
      UPDATE task_board_comments SET created_at = ${at(70)}
      WHERE task_board_item_id = ${sentBack}
    `.execute(database.db);
    await act(sentBack, "status_changed", USER, 75, {
      from: "in_review",
      to: "in_progress",
      reason: "rerun",
    });
    await run(ORG, sentBack, 75);
    await act(sentBack, "review_approved", null, 120);
    await act(sentBack, "status_changed", null, 150, {
      from: "in_review",
      to: "done",
    });

    // Another repo, but the project ran it — so it is the project's. Errored.
    const errored = await card(ORG, "other/site");
    await run(ORG, errored, 5, { project: PROJECT, failed: true });

    // Not the project's at all.
    const elsewhere = await card(ORG, "other/site");
    await run(ORG, elsewhere, 5);
    await act(elsewhere, "status_changed", null, 90, {
      from: "in_review",
      to: "done",
    });

    // Another tenant's card on the same repository.
    const tenant = await card(OTHER_ORG, PROJECT_REPO);
    await run(OTHER_ORG, tenant, 5);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  const project = () => ({
    ...range(),
    orgIds: [ORG],
    project: { id: PROJECT, repo: PROJECT_REPO },
  });

  it("nests the funnel: ran, ran clean, first try, shipped, untouched", async () => {
    const sections = await analytics.operation(project());
    expect(funnel(sections)).toEqual([3, 2, 1, 1, 1]);
  });

  it("rates shipped-untouched over shipped and sent-back over ran", async () => {
    const sections = await analytics.operation(project());
    expect(stat(sections, "Shipped")?.value).toBe(2);
    expect(stat(sections, "Needed a person")?.value).toBe(1);
    expect(stat(sections, "Shipped with no human")?.value).toBe(50);
    expect(stat(sections, "Sent back")?.value).toBe(33.3);
  });

  it("compares against an empty previous window rather than inventing one", async () => {
    const sections = await analytics.operation(project());
    expect(stat(sections, "Shipped")?.previous).toBe(0);
    expect(stat(sections, "Shipped with no human")?.previous).toBeNull();
  });

  it("counts only what people did after the first run, by kind", async () => {
    const sections = await analytics.operation(project());
    expect(bars(sections)).toEqual({ Commented: 1, "Re-ran": 1 });
    const needed = tableRows(sections, "Tasks that needed a person");
    expect(needed.map((r) => r["Task ID"])).toEqual([sentBack]);
    expect(needed[0]?.Actions).toBe(2);
  });

  it("without a project, reads the whole org and never another tenant", async () => {
    const sections = await analytics.operation({ ...range(), orgIds: [ORG] });
    expect(funnel(sections)[0]).toBe(4);
  });

  it("scopes the other reports to the project too", async () => {
    const delivery = await analytics.delivery(project());
    expect(stat(delivery, "Tasks completed")?.value).toBe(2);
    const errors = await analytics.errors(project());
    expect(stat(errors, "Failed runs")?.value).toBe(1);
  });
});
