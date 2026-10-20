/**
 * Real-Postgres coverage for the admin thread analytics SQL: kind attribution
 * (task run > automation > chat), spend/tokens off `finish` parts, org scope,
 * and the live feed's filters.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import type { Section } from "./task-board-analytics";
import { TaskBoardStorage } from "./task-board";
import { ThreadAnalyticsStorage } from "./thread-analytics";
import { SqlThreadStorage } from "./threads";

const ORG_A = "org_thread_analytics_a";
const ORG_B = "org_thread_analytics_b";
const USER = "user_thread_analytics";

const stat = (sections: Section[], label: string) =>
  sections
    .flatMap((s) => (s.kind === "stat" ? s.values : []))
    .find((v) => v.label === label)?.value;

const tableRows = (sections: Section[], title: string) => {
  const s = sections.find((x) => x.kind === "table" && x.title === title);
  if (s?.kind !== "table") throw new Error(`no table ${title}`);
  return s.rows.map((r) =>
    Object.fromEntries(s.columns.map((c, i) => [c, r[i]])),
  );
};

describe("ThreadAnalyticsStorage (real Postgres)", () => {
  let database: StudioDatabase;
  let analytics: ThreadAnalyticsStorage;
  let threads: SqlThreadStorage;
  let taskBoard: TaskBoardStorage;

  const finish = async (
    org: string,
    threadId: string,
    usage: { cost?: number; totalTokens: number },
  ) => {
    await database.db
      .insertInto("thread_message_parts")
      .values({
        id: `${threadId}:${crypto.randomUUID()}`,
        seq: 0,
        org_id: org,
        thread_id: threadId,
        run_id: crypto.randomUUID(),
        message_id: crypto.randomUUID(),
        role: "assistant",
        kind: "finish",
        payload: JSON.stringify({}),
        metadata: JSON.stringify({
          usage: {
            inputTokens: usage.totalTokens / 2,
            outputTokens: usage.totalTokens / 2,
            totalTokens: usage.totalTokens,
            ...(usage.cost === undefined
              ? {}
              : {
                  providerMetadata: {
                    openrouter: { usage: { cost: usage.cost } },
                  },
                }),
          },
        }),
        created_at: new Date().toISOString(),
      })
      .execute();
  };

  const range = () => ({
    from: new Date(Date.now() - 3600_000).toISOString(),
    to: new Date(Date.now() + 3600_000).toISOString(),
  });

  let chatId = "";
  let automationId = "";
  let taskId = "";
  let otherOrgId = "";

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    for (const [id, slug] of [
      [ORG_A, "thread-analytics-a"],
      [ORG_B, "thread-analytics-b"],
    ] as const) {
      await database.db
        .insertInto("organization")
        .values({ id, name: id, slug, createdAt: new Date().toISOString() })
        .execute();
    }
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${"analytics@threads.test"}, false, ${USER}, ${now}, ${now})
    `.execute(database.db);
    await database.db
      .insertInto("automations")
      .values({
        id: "auto_thread_analytics",
        organization_id: ORG_A,
        name: "auto",
        active: true,
        created_by: USER,
        messages: "[]",
        models: "{}",
        temperature: 0.5,
        virtual_mcp_id: "vmcp_test",
        created_at: now,
        updated_at: now,
      })
      .execute();
    for (const id of ["trg_1", "trg_2"]) {
      await database.db
        .insertInto("automation_triggers")
        .values({
          id,
          automation_id: "auto_thread_analytics",
          type: "cron",
          cron_expression: "0 * * * *",
          created_at: now,
        })
        .execute();
    }
    analytics = new ThreadAnalyticsStorage(database.db);
    threads = new SqlThreadStorage(database.db);
    taskBoard = new TaskBoardStorage(database.db);

    const mk = async (org: string, title: string, extra = {}) =>
      (
        await threads.create({
          organization_id: org,
          title,
          status: "completed",
          message_storage_version: 2,
          created_by: USER,
          ...extra,
        })
      ).id;

    chatId = await mk(ORG_A, "a chat");
    automationId = await mk(ORG_A, "an automation", { trigger_id: "trg_1" });
    // A task run that ALSO carries a trigger still counts as a task run.
    taskId = await mk(ORG_A, "a task run", { trigger_id: "trg_2" });
    const card = await taskBoard.create({
      organizationId: ORG_A,
      title: "card",
      status: "in_progress",
      by: USER,
    });
    await taskBoard.linkThread(card.id, taskId, ORG_A);
    otherOrgId = await mk(ORG_B, "other org chat");

    await finish(ORG_A, chatId, { cost: 1.5, totalTokens: 100 });
    await finish(ORG_A, chatId, { totalTokens: 50 }); // unpriced turn
    await finish(ORG_A, automationId, { cost: 2, totalTokens: 200 });
    await finish(ORG_A, taskId, { cost: 4, totalTokens: 400 });
    await finish(ORG_B, otherOrgId, { cost: 10, totalTokens: 1000 });
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("splits spend by kind and reports coverage for one org", async () => {
    const sections = await analytics.usage({ orgIds: [ORG_A], ...range() });
    expect(stat(sections, "Total spend")).toBe(7.5);
    expect(stat(sections, "Tokens")).toBe(750);
    expect(stat(sections, "Orgs")).toBe(1);
    expect(stat(sections, "Cost coverage")).toBe(75);

    const [org] = tableRows(sections, "Spend by org");
    expect(org).toMatchObject({
      Org: "thread-analytics-a",
      "Chats USD": 1.5,
      "Automations USD": 2,
      "Task board USD": 4,
      "Total USD": 7.5,
    });
  });

  it("the all-orgs aggregate includes every tenant", async () => {
    const sections = await analytics.usage({ orgIds: null, ...range() });
    expect(stat(sections, "Total spend")).toBe(17.5);
    const top = tableRows(sections, "Top orgs by spend (fixed windows)");
    expect(top[0]?.Org).toBe("thread-analytics-b");
  });

  it("live feed is org-scoped, filters by kind, and sums each thread's spend", async () => {
    const all = await analytics.live({ orgIds: [ORG_A], limit: 50 });
    expect(all.threads.map((t) => t.id).sort()).toEqual(
      [chatId, automationId, taskId].sort(),
    );
    const chat = all.threads.find((t) => t.id === chatId);
    expect(chat).toMatchObject({ kind: "chat", usd: 1.5, tokens: 150 });

    const tasks = await analytics.live({
      orgIds: [ORG_A],
      kind: "task",
      limit: 50,
    });
    expect(tasks.threads.map((t) => t.id)).toEqual([taskId]);
  });

  it("errors surface failed threads with their error text", async () => {
    await database.db
      .updateTable("threads")
      .set({ status: "failed", updated_at: new Date().toISOString() })
      .where("id", "=", automationId)
      .execute();
    await database.db
      .insertInto("thread_message_parts")
      .values({
        id: `${automationId}:err`,
        seq: 1,
        org_id: ORG_A,
        thread_id: automationId,
        run_id: crypto.randomUUID(),
        message_id: crypto.randomUUID(),
        role: "assistant",
        kind: "error",
        payload: JSON.stringify({ text: "boom 42" }),
        created_at: new Date().toISOString(),
      })
      .execute();

    const sections = await analytics.errors({ orgIds: [ORG_A], ...range() });
    expect(stat(sections, "Failed threads")).toBe(1);
    const [feed] = tableRows(sections, "Live error feed");
    expect(feed).toMatchObject({ Kind: "automation", Error: "boom 42" });

    const live = await analytics.live({
      orgIds: [ORG_A],
      status: "failed",
      limit: 10,
    });
    expect(live.threads[0]).toMatchObject({
      id: automationId,
      lastError: "boom 42",
    });
    expect(live.counts.failedLastHour).toBe(1);
  });
});
