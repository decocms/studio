/**
 * Real-Postgres coverage for `appendThreadGithubRepo`.
 *
 * The append is written as one UPDATE rather than a read in JS followed by a
 * write, because the model can fire two `TASK_ADD_REPO` calls at once and a
 * read-modify-write loses the slower one. That property only exists in the SQL,
 * so an in-memory fake would happily agree with a version that drops writes.
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

const ORG = "org_thread_repos_1";
const USER = "user_tr1";

const repo = (owner: string, name: string) => ({
  url: `https://github.com/${owner}/${name}`,
  owner,
  name,
  connectionId: `conn_${name}`,
});

describe("appendThreadGithubRepo", () => {
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
        slug: "org-thread-repos-1",
        createdAt: now,
      })
      .execute();
    // Raw SQL: real Postgres has a BOOLEAN emailVerified the typed shape disagrees with.
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${"tr1@repos.test"}, false, ${USER}, ${now}, ${now})
    `.execute(database.db);
    threads = new SqlThreadStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("accumulates repos instead of replacing the last one", async () => {
    const id = await newThread("thr_accumulate");
    expect(
      await threads.appendThreadGithubRepo(id, ORG, repo("acme", "web")),
    ).toHaveLength(1);
    const both = await threads.appendThreadGithubRepo(
      id,
      ORG,
      repo("acme", "checkout"),
    );
    expect(both.map((r) => r.name)).toEqual(["web", "checkout"]);
  });

  it("treats re-adding the same repo as a no-op, not a duplicate", async () => {
    const id = await newThread("thr_dedupe");
    await threads.appendThreadGithubRepo(id, ORG, repo("acme", "web"));
    const again = await threads.appendThreadGithubRepo(
      id,
      ORG,
      repo("ACME", "Web"),
    );
    expect(again).toHaveLength(1);
  });

  it("loses nothing when two adds land at once", async () => {
    const id = await newThread("thr_race");
    await Promise.all([
      threads.appendThreadGithubRepo(id, ORG, repo("acme", "web")),
      threads.appendThreadGithubRepo(id, ORG, repo("acme", "checkout")),
      threads.appendThreadGithubRepo(id, ORG, repo("acme", "design")),
    ]);
    const row = await database.db
      .selectFrom("threads")
      .select(sql<{ name: string }[]>`metadata->'githubRepos'`.as("repos"))
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row.repos.map((r) => r.name).sort()).toEqual([
      "checkout",
      "design",
      "web",
    ]);
  });

  it("leaves the rest of the thread's metadata alone", async () => {
    const id = await newThread("thr_metadata");
    await threads.update(id, ORG, { metadata: { read_only: true } });
    await threads.appendThreadGithubRepo(id, ORG, repo("acme", "web"));
    const thread = await threads.get(id, ORG);
    expect(thread?.metadata).toMatchObject({ read_only: true });
  });

  it("returns nothing for a thread in another org", async () => {
    const id = await newThread("thr_other_org");
    expect(
      await threads.appendThreadGithubRepo(
        id,
        "org_someone_else",
        repo("a", "b"),
      ),
    ).toEqual([]);
  });
});
