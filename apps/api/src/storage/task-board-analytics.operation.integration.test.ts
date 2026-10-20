/**
 * Real-Postgres coverage for the task board operation report and project
 * scoping: the funnel's nested stages, what failing QA means (the reviewer
 * asked for changes, nothing else), what counts as a person stepping in (only
 * after the first run), and which cards a project owns.
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
  parseDrill,
  type Section,
  TaskBoardAnalyticsStorage,
} from "./task-board-analytics";
import { SqlThreadStorage } from "./threads";

const ORG = "org_board_analytics_a";
const OTHER_ORG = "org_board_analytics_b";
const USER = "user_board_analytics";
const PROJECT = "vir_board_analytics";
const PROJECT_REPO = "acme/shop";
const UI_TAG = "tag_board_analytics_ui";
const SPRINT = "sprint_board_analytics";

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
    opts: { project?: string; failed?: boolean; usd?: number } = {},
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
    if (opts.usd !== undefined) {
      const usage = {
        usage: {
          providerMetadata: { openrouter: { usage: { cost: opts.usd } } },
        },
      };
      await sql`
        INSERT INTO thread_message_parts (id, seq, org_id, thread_id, run_id, message_id, role, kind, payload, metadata, created_at, persisted_at)
        VALUES (${crypto.randomUUID()}, 1, ${org}, ${thread.id}, ${`run_${thread.id}`}, ${`msg_${thread.id}`},
                'assistant', 'finish', '{}', ${JSON.stringify(usage)}, ${at(minutes)}, ${at(minutes)})
      `.execute(database.db);
    }
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
  let rerunOnly = "";
  let notRun = "";
  let customerCard = "";

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
    await run(ORG, sentBack, 5, { usd: 1 });
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
    await run(ORG, sentBack, 75, { usd: 1.5 });
    await act(sentBack, "review_approved", null, 120);
    await act(sentBack, "status_changed", null, 150, {
      from: "in_review",
      to: "done",
    });

    // Re-run by a person while in QA, with no verdict: stepping in, not failing QA.
    rerunOnly = await card(ORG, PROJECT_REPO);
    await run(ORG, rerunOnly, 5);
    await act(rerunOnly, "status_changed", null, 40, {
      from: "in_progress",
      to: "in_review",
    });
    await act(rerunOnly, "status_changed", USER, 50, {
      from: "in_review",
      to: "in_progress",
      reason: "rerun",
    });

    // Another repo, but the project ran it — so it is the project's. Errored.
    const errored = await card(ORG, "other/site");
    await run(ORG, errored, 5, { project: PROJECT, failed: true });

    // Not the project's: through the customer's lane, and the customer sent it back.
    customerCard = await card(ORG, "other/site");
    await run(ORG, customerCard, 5);
    await act(customerCard, "review_approved", null, 40);
    await act(customerCard, "status_changed", null, 50, {
      from: "in_review",
      to: "customer_approval",
    });
    await act(customerCard, "status_changed", USER, 60, {
      from: "customer_approval",
      to: "in_progress",
    });

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

    // The sent-back card is UI work in the running sprint, next to one never run.
    await sql`
      INSERT INTO organization_tags (id, organization_id, name, color, created_at)
      VALUES (${UI_TAG}, ${ORG}, 'UI', null, ${at(0)})
    `.execute(database.db);
    await sql`
      INSERT INTO task_board_item_tags (task_board_item_id, id, created_by, created_at)
      VALUES (${sentBack}, ${UI_TAG}, ${USER}, ${at(0)})
    `.execute(database.db);
    await sql`
      INSERT INTO task_board_sprints (id, organization_id, name, state, start_date, end_date, created_by, created_at, updated_at)
      VALUES (${SPRINT}, ${ORG}, 'Sprint 1', 'active', ${at(0).slice(0, 10)}, null, ${USER}, ${at(0)}, ${at(0)})
    `.execute(database.db);
    notRun = await card(ORG, PROJECT_REPO);
    await sql`
      UPDATE task_board_items SET sprint_id = ${SPRINT}
      WHERE id = any(${[sentBack, notRun]}::text[])
    `.execute(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  const project = () => ({
    ...range(),
    orgIds: [ORG],
    project: { id: PROJECT, repo: PROJECT_REPO },
  });

  it("nests the funnel: ran, reached QA, passed QA first try, no failed runs, shipped, untouched", async () => {
    const sections = await analytics.operation(project());
    // The errored card never reached QA, so it leaves at the second stage.
    expect(funnel(sections)).toEqual([4, 3, 2, 2, 1, 1]);
  });

  it("counts reached QA the same in the funnel and in Failed QA's denominator", async () => {
    const sections = await analytics.operation(project());
    expect(funnel(sections)[1]).toBe(3);
    expect(stat(sections, "Failed QA")?.detail).toBe("1 of 3 that reached QA");
  });

  it("leads with what shipped, then autonomy, then QA, then people", async () => {
    const sections = await analytics.operation(project());
    const first = sections[0];
    expect(first?.kind === "stat" && first.values.map((v) => v.label)).toEqual([
      "Shipped",
      "Shipped on its own",
      "Failed QA",
      "Sent back by a person",
    ]);
  });

  it("fails QA only on the reviewer's changes requested, out of cards that reached QA", async () => {
    const sections = await analytics.operation(project());
    const failed = stat(sections, "Failed QA");
    expect(failed?.value).toBe(33.3);
    expect(failed?.detail).toBe("1 of 3 that reached QA");
  });

  it("rates shipped-untouched over shipped, and says what each figure is out of", async () => {
    const sections = await analytics.operation(project());
    expect(stat(sections, "Shipped")?.value).toBe(2);
    expect(stat(sections, "Shipped")?.detail).toBe("of 4 picked up");
    expect(stat(sections, "Sent back by a person")?.value).toBe(2);
    expect(stat(sections, "Shipped on its own")?.value).toBe(50);
    expect(stat(sections, "Shipped on its own")?.detail).toBe("1 of 2 shipped");
  });

  it("compares against an empty previous window rather than inventing one", async () => {
    const sections = await analytics.operation(project());
    expect(stat(sections, "Shipped")?.previous).toBe(0);
    expect(stat(sections, "Shipped on its own")?.previous).toBeNull();
  });

  it("counts only what people did after the first run, by intent", async () => {
    const sections = await analytics.operation(project());
    // A re-run sends work back; a comment only guides it.
    expect(bars(sections)).toEqual({ "Sent back": 2, Guided: 1 });
    expect(await ids("class:return")).toHaveLength(2);
    const needed = tableRows(sections, "Tasks that needed a person");
    expect(needed.map((r) => r["Task ID"])).toEqual([sentBack, rerunOnly]);
    expect(needed[0]?.Actions).toBe(2);
  });

  it("lists the cards behind each figure, matching its count", async () => {
    const sections = await analytics.operation(project());
    const first = sections[0];
    const shown = first?.kind === "stat" ? first.values : [];
    expect(shown.map((v) => v.drill)).toEqual([
      "shipped",
      "shipped_untouched",
      "failed_qa",
      "returned",
    ]);
    expect(await ids("failed_qa")).toEqual([sentBack]);
    expect((await ids("returned")).sort()).toEqual(
      [sentBack, rerunOnly].sort(),
    );
    expect(await ids("ran")).toHaveLength(4);
    expect(await ids("touch:Commented")).toEqual([sentBack]);
    expect(await ids("touch:Approved by hand")).toEqual([]);
  });

  const ids = async (drill: string) =>
    tableRows(
      await analytics.operationTasks(project(), parseDrill(drill) ?? []),
      "Tasks",
    ).map((r) => r["Task ID"]);

  it("cuts rework by tag, with a drill per group that lists the same cards", async () => {
    const sections = await analytics.rework(project());
    const cut = sections.find((s) => s.kind === "breakdown");
    if (cut?.kind !== "breakdown") throw new Error("no breakdown");
    const byTag = cut.dimensions.find((d) => d.label === "Tag")?.rows ?? [];
    const ui = byTag.find((r) => r.label === "UI");
    expect(ui?.count).toBe(1);
    expect(ui?.values.failed_qa).toBe(100);
    expect(byTag.find((r) => r.label === "No tag")?.count).toBe(3);
    expect(await ids(ui?.drill ?? "")).toEqual([sentBack]);
    expect(await ids(`tag:${UI_TAG}&failed_qa`)).toEqual([sentBack]);
    expect(await ids("tag:none&failed_qa")).toEqual([]);
  });

  it("judges a sprint by every card committed to it, run or not", async () => {
    const sections = await analytics.sprints(project());
    const sprints = tableRows(sections, "Sprints");
    expect(sprints).toHaveLength(1);
    expect(sprints[0]?.Committed).toBe(2);
    expect(sprints[0]?.Completed).toBe(1);
    expect((await ids(`planned&sprint:${SPRINT}`)).sort()).toEqual(
      [sentBack, notRun].sort(),
    );
    // "Still open" lists what its figure counts: the unshipped card only.
    expect(await ids(`planned&sprint:${SPRINT}&still_open`)).toEqual([notRun]);
    // Without `planned`, only cards first run in range: the unrun card drops.
    expect(await ids(`sprint:${SPRINT}`)).toEqual([sentBack]);
  });

  it("names who moved a stuck card in and who sent it to the agent", async () => {
    const stuck = tableRows(
      await analytics.stuck(project()),
      "Stuck right now",
    );
    const rerun = stuck.find((r) => r["Task ID"] === rerunOnly);
    expect(rerun?.["Moved in by"]).toBe(USER);
    expect(rerun?.["Sent by"]).toBe(USER);
  });

  it("says who sent work back: the QA Agent, the team, or the customer", async () => {
    const rework = await analytics.rework(project());
    const who = rework.find(
      (s) => s.kind === "bars" && s.title === "Who sent it back",
    );
    if (who?.kind !== "bars") throw new Error("no bars");
    expect(Object.fromEntries(who.bars.map((b) => [b.label, b.value]))).toEqual(
      { "QA Agent": 1, Team: 2 },
    );
    expect(await ids("source:QA Agent")).toEqual([sentBack]);
  });

  it("counts the rounds each shipped task took", async () => {
    const rework = await analytics.rework(project());
    const rounds = rework.find(
      (s) => s.kind === "bars" && s.title === "Rounds to ship",
    );
    if (rounds?.kind !== "bars") throw new Error("no rounds");
    // QA said no, then a person re-ran it the same hour: one round, not two.
    expect(rounds.bars.map((b) => b.value)).toEqual([1, 1, 0]);
    expect(await ids("shipped_round_2")).toEqual([sentBack]);
  });

  it("prices rework as the runs after a task was first sent back", async () => {
    const rework = await analytics.rework(project());
    expect(stat(rework, "Spent on rework")?.value).toBe(1.5);
    expect(stat(rework, "Spent on rework")?.detail).toBe(
      "60% of $2.50 on these tasks",
    );
    // No customer lane on this project, so no escape rate.
    expect(stat(rework, "Escaped QA")).toBeUndefined();
  });

  it("adds the customer step and the QA escape rate where the customer's lane is used", async () => {
    const org = { ...range(), orgIds: [ORG] };
    const sections = await analytics.operation(org);
    const stages = sections.find((s) => s.kind === "funnel");
    if (stages?.kind !== "funnel") throw new Error("no funnel");
    expect(stages.stages.map((s) => s.label)).toContain(
      "Not sent back by the customer",
    );
    const rework = await analytics.rework(org);
    expect(stat(rework, "Escaped QA")?.value).toBe(100);
    expect(stat(rework, "Escaped QA")?.detail).toBe(
      "customer sent back 1 of 1 it saw",
    );
    expect(
      tableRows(
        await analytics.operationTasks(
          org,
          parseDrill("source:Customer") ?? [],
        ),
        "Tasks",
      ).map((r) => r["Task ID"]),
    ).toEqual([customerCard]);
  });

  it("without a project, reads the whole org and never another tenant", async () => {
    const sections = await analytics.operation({ ...range(), orgIds: [ORG] });
    expect(funnel(sections)[0]).toBe(6);
  });

  it("judges the previous window at the same age, and archiving is no send-back", async () => {
    const org = "org_board_analytics_c";
    await database.db
      .insertInto("organization")
      .values({
        id: org,
        name: org,
        slug: "board-analytics-c",
        createdAt: new Date().toISOString(),
      })
      .execute();
    // Ran in the previous window but shipped only after it closed.
    const late = await card(org, PROJECT_REPO);
    await run(org, late, -120);
    await act(late, "status_changed", null, 0, {
      from: "in_review",
      to: "done",
    });
    const shelved = await card(org, PROJECT_REPO);
    await run(org, shelved, 5);
    await act(shelved, "status_changed", USER, 30, {
      from: "in_review",
      to: "archived",
    });
    await act(shelved, "status_changed", USER, 40, {
      from: "archived",
      to: "todo",
    });
    const sections = await analytics.operation({ ...range(), orgIds: [org] });
    expect(stat(sections, "Shipped")?.previous).toBe(0);
    expect(stat(sections, "Sent back by a person")?.value).toBe(0);
  });

  it("scopes the other reports to the project too", async () => {
    const delivery = await analytics.delivery(project());
    expect(stat(delivery, "Tasks completed")?.value).toBe(2);
    const errors = await analytics.errors(project());
    expect(stat(errors, "Failed runs")?.value).toBe(1);
  });

  /** Two projects over one repository: the tool narrows with `repo: null`
   *  (`ownRepo`), so only a stamp or a run says whose a card is. */
  it("counts a card on a shared repository only for the project it is stamped for", async () => {
    const SIBLING = "vir_board_analytics_sibling";
    await sql`
      INSERT INTO connections (id, organization_id, created_by, title, connection_type, connection_url)
      VALUES (${PROJECT}, ${ORG}, ${USER}, 'project', 'VIRTUAL', 'virtual://project'),
             (${SIBLING}, ${ORG}, ${USER}, 'sibling', 'VIRTUAL', 'virtual://sibling')
    `.execute(database.db);
    const shared = (id: string) => ({
      ...range(),
      orgIds: [ORG],
      project: { id, repo: null },
    });
    const ran = async (query: AnalyticsQuery) =>
      tableRows(
        await analytics.operationTasks(query, parseDrill("ran") ?? []),
        "Tasks",
      ).map((r) => r["Task ID"]);

    expect(await ran(shared(PROJECT))).not.toContain(sentBack);
    await sql`
      UPDATE task_board_items SET virtual_mcp_id = ${PROJECT} WHERE id = ${sentBack}
    `.execute(database.db);
    try {
      expect(await ran(shared(PROJECT))).toContain(sentBack);
      expect(await ran(shared(SIBLING))).not.toContain(sentBack);
    } finally {
      await sql`
        UPDATE task_board_items SET virtual_mcp_id = null WHERE id = ${sentBack}
      `.execute(database.db);
    }
  });
});
