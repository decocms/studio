/**
 * Real-Postgres coverage for `addRunJiraIssue`.
 *
 * The add is one UPDATE over the jsonb metadata, so what it does to the set —
 * seeding from the pre-batch single key, skipping a repeat, surviving
 * concurrent calls — only exists in the SQL.
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

describe("addRunJiraIssue", () => {
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

  it("adds the key to the run's set, and to its creations only when it created it", async () => {
    const id = await runThread("thr_add", {
      source: "jira",
      jira_issue_keys: ["EX-1", "EX-2"],
    });
    expect(
      await threads.addRunJiraIssue(id, ORG, "EX-9", { created: true }),
    ).toEqual(["EX-1", "EX-2", "EX-9"]);
    await threads.addRunJiraIssue(id, ORG, "EX-5", { created: false });
    const thread = await threads.get(id, ORG);
    expect(thread?.metadata).toMatchObject({
      source: "jira",
      jira_issue_keys: ["EX-1", "EX-2", "EX-9", "EX-5"],
      jira_created_issue_keys: ["EX-9"],
    });
  });

  it("keeps a pre-batch run's single key in the set", async () => {
    const id = await runThread("thr_single", {
      source: "jira",
      jira_issue_key: "EX-1",
    });
    expect(
      await threads.addRunJiraIssue(id, ORG, "EX-9", { created: true }),
    ).toEqual(["EX-1", "EX-9"]);
  });

  it("treats adding the same key again as a no-op", async () => {
    const id = await runThread("thr_repeat", {
      source: "jira",
      jira_issue_keys: ["EX-1"],
    });
    await threads.addRunJiraIssue(id, ORG, "EX-9", { created: true });
    await threads.addRunJiraIssue(id, ORG, "EX-9", { created: true });
    const thread = await threads.get(id, ORG);
    expect(thread?.metadata).toMatchObject({
      jira_issue_keys: ["EX-1", "EX-9"],
      jira_created_issue_keys: ["EX-9"],
    });
  });

  it("loses nothing when two adds land at once", async () => {
    const id = await runThread("thr_race", {
      source: "jira",
      jira_issue_keys: ["EX-1"],
    });
    await Promise.all([
      threads.addRunJiraIssue(id, ORG, "EX-7", { created: true }),
      threads.addRunJiraIssue(id, ORG, "EX-8", { created: true }),
      threads.addRunJiraIssue(id, ORG, "EX-9", { created: true }),
    ]);
    const thread = await threads.get(id, ORG);
    const keys = thread?.metadata.jira_issue_keys as string[];
    expect([...keys].sort()).toEqual(["EX-1", "EX-7", "EX-8", "EX-9"]);
  });

  it("refuses a thread in another org", async () => {
    const id = await runThread("thr_other_org", {
      source: "jira",
      jira_issue_keys: ["EX-1"],
    });
    await expect(
      threads.addRunJiraIssue(id, "org_someone_else", "EX-9", {
        created: true,
      }),
    ).rejects.toThrow("not found");
  });
});
