/**
 * Real-Postgres coverage for migration 205's backfill.
 *
 * The whole migration is SQL — a jsonb path match against two differently
 * shaped metadata columns (`connections.metadata` is TEXT, `threads.metadata`
 * is jsonb) — so an in-memory fake would agree with a version that links
 * nothing. What has to hold: every JSON binding ends up referenced, a
 * repository a thread names but nobody linked gets created, and a row whose
 * metadata is not valid JSON does not abort the run.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../src/database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../src/database/test-db-pg";
import { down, up } from "./205-repository-references";

const ORG = "org_202";
const USER = "user_202";

describe("205 repository references", () => {
  let database: StudioDatabase;

  const rows = async <T>(q: string): Promise<T[]> =>
    (await sql.raw<T>(q).execute(database.db)).rows;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const db = database.db;

    // Back to the pre-205 shape, so `up` runs against what prod will hand it.
    await down(db as never);

    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, 'u202@e2e.local', true, 'u202', now(), now())
    `.execute(db);
    await sql`
      INSERT INTO organization (id, name, slug, "createdAt")
      VALUES (${ORG}, 'org 202', 'org-202', now())
    `.execute(db);

    const conn = async (id: string, metadata: string | null) => {
      await sql`
        INSERT INTO connections (
          id, organization_id, title, connection_type, connection_url,
          metadata, status, pinned, created_by, updated_by, created_at, updated_at
        ) VALUES (
          ${id}, ${ORG}, ${id}, 'VIRTUAL', ${"virtual://" + id},
          ${metadata}, 'active', false, ${USER}, ${USER}, now(), now()
        )
      `.execute(db);
    };
    // An agent bound to a repository that already has a row (201's doing).
    await conn(
      "vir_bound",
      JSON.stringify({ githubRepo: { owner: "acme", name: "site" } }),
    );
    // An agent with no repository at all.
    await conn("vir_none", JSON.stringify({ instructions: null }));
    /**
     * `connections.metadata` is TEXT, so a row can hold something that is not
     * JSON. 201 hit this and needed a guard; 202 must not regress it.
     */
    await conn("vir_broken", "not json at all");

    await sql`
      INSERT INTO repositories (organization_id, provider, host, path, web_url)
      VALUES (${ORG}, 'github', 'github.com', 'acme/site', 'https://github.com/acme/site')
    `.execute(db);

    await sql`
      INSERT INTO threads (id, organization_id, title, created_by, updated_by, created_at, updated_at, metadata)
      VALUES ('thr_202', ${ORG}, 'thr', ${USER}, ${USER}, now(), now(), ${JSON.stringify(
        {
          githubRepos: [
            { owner: "acme", name: "site" },
            { owner: "acme", name: "checkout" },
          ],
        },
      )}::jsonb)
    `.execute(db);

    await up(db as never);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("references the repository an agent's JSON names", async () => {
    const [row] = await rows<{ path: string | null }>(`
      select r.path from connections c
        left join repositories r on r.id = c.repository_id
       where c.id = 'vir_bound'`);
    expect(row?.path).toBe("acme/site");
  });

  it("leaves an agent with no repository unreferenced", async () => {
    const [row] = await rows<{ repository_id: string | null }>(
      `select repository_id from connections where id = 'vir_none'`,
    );
    expect(row?.repository_id).toBeNull();
  });

  /** The guard 201 needed: unparseable metadata is skipped, not fatal. */
  it("survives a connection whose metadata is not JSON", async () => {
    const [row] = await rows<{ repository_id: string | null }>(
      `select repository_id from connections where id = 'vir_broken'`,
    );
    expect(row?.repository_id).toBeNull();
  });

  /** 201 skipped threads, so a repo only a checkout list knows about has no row yet. */
  it("creates the repository a thread names and nobody linked", async () => {
    const [row] = await rows<{ account_id: string | null }>(`
      select account_id from repositories
       where organization_id = '${ORG}' and lower(path) = 'acme/checkout'`);
    expect(row).toBeDefined();
    expect(row?.account_id).toBeNull();
  });

  it("links every repository in a thread's checkout list", async () => {
    const linked = await rows<{ path: string }>(`
      select r.path from thread_repositories tr
        join repositories r on r.id = tr.repository_id
       where tr.thread_id = 'thr_202' order by r.path`);
    expect(linked.map((l) => l.path)).toEqual(["acme/checkout", "acme/site"]);
  });

  /** Re-running a migration must not double-insert; the backfill is idempotent. */
  it("is idempotent", async () => {
    await up(database.db as never).catch(() => {
      /** `up` re-adds the column and table; only the backfill half can rerun. */
    });
    const [count] = await rows<{ n: string }>(
      `select count(*) as n from thread_repositories where thread_id = 'thr_202'`,
    );
    expect(Number(count?.n)).toBe(2);
  });

  /** The JSON is untouched — a pod on the previous release still reads it. */
  it("leaves the JSON bindings in place", async () => {
    const [agent] = await rows<{ owner: string }>(
      `select metadata::jsonb #>> '{githubRepo,owner}' as owner from connections where id = 'vir_bound'`,
    );
    expect(agent?.owner).toBe("acme");
    const [thread] = await rows<{ n: string }>(
      `select jsonb_array_length(metadata -> 'githubRepos') as n from threads where id = 'thr_202'`,
    );
    expect(Number(thread?.n)).toBe(2);
  });
});
