/**
 * Real-Postgres coverage for `recordJiraIssueCreated`.
 *
 * The record is one UPDATE over the jsonb metadata, so what it does to the
 * list — skipping a repeat, surviving concurrent calls, leaving the rest of
 * the metadata alone — only exists in the SQL.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import { SqlThreadStorage } from "./threads";

const ORG = "org_thread_jira_1";
const USER = "user_tj1";

describe("recordJiraIssueCreated", () => {
  let database: StudioDatabase;
  let threads: SqlThreadStorage;

  const newThread = async (id: string) => {
    const now = new Date().toISOString();
    await sql`
      INSERT INTO threads (id, organization_id, title, created_by, updated_by, created_at, updated_at)
      VALUES (${id}, ${ORG}, ${id}, ${USER}, ${USER}, ${now}, ${now})
    `.execute(database.db);
    return id;
  };

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const now = new Date().toISOString();
    await database.db
      .insertInto("organization")
      .values({
        id: ORG,
        name: ORG,
        slug: "org-thread-jira-1",
        createdAt: now,
      })
      .execute();
    // Raw SQL: real Postgres has a BOOLEAN emailVerified the typed shape disagrees with.
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${"tj1@jira.test"}, false, ${USER}, ${now}, ${now})
    `.execute(database.db);
    threads = new SqlThreadStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  const runThread = async (id: string, metadata: Record<string, unknown>) => {
    await newThread(id);
    await threads.update(id, ORG, { metadata });
    return id;
  };

  const RUN = { source: "jira", jira_issue_keys: ["EX-1"] };

  it("appends to the run's creations and leaves the rest of the metadata alone", async () => {
    const id = await runThread("thr_add", RUN);
    expect(await threads.recordJiraIssueCreated(id, ORG, "EX-9")).toEqual([
      "EX-9",
    ]);
    expect(await threads.recordJiraIssueCreated(id, ORG, "EX-10")).toEqual([
      "EX-9",
      "EX-10",
    ]);
    const thread = await threads.get(id, ORG);
    expect(thread?.metadata).toMatchObject({
      source: "jira",
      jira_issue_keys: ["EX-1"],
    });
  });

  it("treats recording the same key again as a no-op", async () => {
    const id = await runThread("thr_repeat", RUN);
    await threads.recordJiraIssueCreated(id, ORG, "EX-9");
    expect(await threads.recordJiraIssueCreated(id, ORG, "EX-9")).toEqual([
      "EX-9",
    ]);
  });

  it("loses nothing when two records land at once", async () => {
    const id = await runThread("thr_race", RUN);
    await Promise.all([
      threads.recordJiraIssueCreated(id, ORG, "EX-7"),
      threads.recordJiraIssueCreated(id, ORG, "EX-8"),
      threads.recordJiraIssueCreated(id, ORG, "EX-9"),
    ]);
    const thread = await threads.get(id, ORG);
    const keys = thread?.metadata.jira_created_issue_keys as string[];
    expect([...keys].sort()).toEqual(["EX-7", "EX-8", "EX-9"]);
  });

  it("refuses a thread in another org", async () => {
    const id = await runThread("thr_other_org", RUN);
    await expect(
      threads.recordJiraIssueCreated(id, "org_someone_else", "EX-9"),
    ).rejects.toThrow("not found");
  });
});
