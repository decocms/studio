/**
 * Real-Postgres coverage for migration 215's backfill.
 *
 * The whole migration is SQL against TEXT columns holding JSON, matched by the
 * SHAPE of two well-known ids. An in-memory fake would agree with a version
 * that links nothing. What has to hold: an org whose pick already has a
 * repository row reuses it (account and all), an org whose pick has none gets
 * an account-less one, a state that already names a repository is untouched,
 * an agent bound elsewhere is not overruled, and a row whose JSON never parsed
 * does not abort the run.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../src/database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../src/database/test-db-pg";
import { down, up } from "./215-commerce-discovery-repository";

setDefaultTimeout(30_000);

const USER = "user_215";
/** Linked already, through Settings — its row carries an account. */
const ORG_LINKED = "org_215_linked";
/** Onboarded through the old form only — nothing ever made a row for its pick. */
const ORG_UNLINKED = "org_215_unlinked";
/** Its state already names a repository; the migration must not touch it. */
const ORG_DONE = "org_215_done";
/** Its `github_repo` is not `owner/name`, and its agent metadata is not JSON. */
const ORG_BROKEN = "org_215_broken";

describe("215 commerce discovery repository", () => {
  let database: StudioDatabase;

  const rows = async <T>(q: string): Promise<T[]> =>
    (await sql.raw<T>(q).execute(database.db)).rows;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const db = database.db;
    await down(db as never);

    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, 'u215@e2e.local', true, 'u215', now(), now())
    `.execute(db);

    for (const org of [ORG_LINKED, ORG_UNLINKED, ORG_DONE, ORG_BROKEN]) {
      await sql`
        INSERT INTO organization (id, name, slug, "createdAt")
        VALUES (${org}, ${org}, ${org.replace(/_/g, "-")}, now())
      `.execute(db);
    }

    const conn = async (
      id: string,
      org: string,
      type: "HTTP" | "VIRTUAL",
      cols: { state?: string | null; metadata?: string | null },
    ) => {
      await sql`
        INSERT INTO connections (
          id, organization_id, title, connection_type, connection_url,
          configuration_state, metadata, status, pinned,
          created_by, updated_by, created_at, updated_at
        ) VALUES (
          ${id}, ${org}, ${id}, ${type}, ${"https://cd.example/" + id},
          ${cols.state ?? null}, ${cols.metadata ?? null}, 'active', false,
          ${USER}, ${USER}, now(), now()
        )
      `.execute(db);
    };

    const cdId = (org: string) => `${org}_commerce-discovery`;
    const agentId = (org: string) => `commerce-discovery_${org}`;

    // Already linked: the account-bearing row must survive the backfill.
    await sql`
      INSERT INTO git_provider_accounts
        (id, organization_id, type, host, auth_kind, external_account_id, login, status)
      VALUES ('acct_215', ${ORG_LINKED}, 'github', 'github.com', 'github_app', '1', 'acme', 'active')
    `.execute(db);
    await sql`
      INSERT INTO repositories (id, organization_id, account_id, provider, host, path, web_url, default_branch)
      VALUES ('repo_215_linked', ${ORG_LINKED}, 'acct_215', 'github', 'github.com',
              'acme/storefront', 'https://github.com/acme/storefront', 'main')
    `.execute(db);
    await conn(cdId(ORG_LINKED), ORG_LINKED, "HTTP", {
      state: JSON.stringify({
        github_repo: "acme/storefront",
        siteUrl: "a.com",
      }),
    });
    await conn(agentId(ORG_LINKED), ORG_LINKED, "VIRTUAL", {
      metadata: JSON.stringify({
        githubRepo: { owner: "acme", name: "storefront" },
      }),
    });

    // Never linked: the migration has to create the row itself.
    await conn(cdId(ORG_UNLINKED), ORG_UNLINKED, "HTTP", {
      state: JSON.stringify({ github_repo: "acme/checkout" }),
    });
    await conn(agentId(ORG_UNLINKED), ORG_UNLINKED, "VIRTUAL", {
      metadata: JSON.stringify({
        githubRepo: { owner: "acme", name: "checkout" },
      }),
    });

    // Already carries a reference — and an agent bound somewhere else.
    await sql`
      INSERT INTO repositories (id, organization_id, provider, host, path, web_url)
      VALUES ('repo_215_done', ${ORG_DONE}, 'gitlab', 'gitlab.example.dev',
              'group/sub/project', 'https://gitlab.example.dev/group/sub/project')
    `.execute(db);
    await conn(cdId(ORG_DONE), ORG_DONE, "HTTP", {
      state: JSON.stringify({
        github_repo: "acme/legacy",
        repository: {
          repository_id: "repo_215_done",
          provider: "gitlab",
          host: "gitlab.example.dev",
          path: "group/sub/project",
        },
      }),
    });
    await conn(agentId(ORG_DONE), ORG_DONE, "VIRTUAL", {
      metadata: JSON.stringify({
        githubRepo: { owner: "someone", name: "else" },
      }),
    });

    // Neither column parses into something usable.
    await conn(cdId(ORG_BROKEN), ORG_BROKEN, "HTTP", {
      state: JSON.stringify({ github_repo: "https://github.com/acme/site" }),
    });
    await conn(agentId(ORG_BROKEN), ORG_BROKEN, "VIRTUAL", {
      metadata: "not json at all",
    });

    await up(db as never);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("references the repository the org already linked, keeping its account", async () => {
    const [row] = await rows<{ repository_id: string; account_id: string }>(`
      select cd_state.repository_id, r.account_id
        from connections c
        cross join lateral (
          select (c.configuration_state::jsonb #>> '{repository,repository_id}') as repository_id
        ) cd_state
        join repositories r on r.id = cd_state.repository_id
       where c.id = '${ORG_LINKED}_commerce-discovery'`);
    expect(row?.repository_id).toBe("repo_215_linked");
    expect(row?.account_id).toBe("acct_215");
  });

  it("writes the whole reference, not just the id", async () => {
    const [row] = await rows<{ repository: Record<string, unknown> }>(`
      select (configuration_state::jsonb -> 'repository') as repository
        from connections where id = '${ORG_LINKED}_commerce-discovery'`);
    expect(row?.repository).toMatchObject({
      repository_id: "repo_215_linked",
      provider: "github",
      host: "github.com",
      path: "acme/storefront",
      default_branch: "main",
      web_url: "https://github.com/acme/storefront",
    });
  });

  it("keeps the legacy string, so a reader one release behind still finds it", async () => {
    const [row] = await rows<{ github_repo: string | null }>(`
      select (configuration_state::jsonb ->> 'github_repo') as github_repo
        from connections where id = '${ORG_LINKED}_commerce-discovery'`);
    expect(row?.github_repo).toBe("acme/storefront");
  });

  it("creates an account-less row for a pick nobody had linked", async () => {
    const [row] = await rows<{ id: string; account_id: string | null }>(`
      select id, account_id from repositories
       where organization_id = '${ORG_UNLINKED}' and lower(path) = 'acme/checkout'`);
    expect(row).toBeDefined();
    expect(row?.account_id).toBeNull();

    const [cd] = await rows<{ repository_id: string | null }>(`
      select (configuration_state::jsonb #>> '{repository,repository_id}') as repository_id
        from connections where id = '${ORG_UNLINKED}_commerce-discovery'`);
    expect(cd?.repository_id).toBe(row?.id);
  });

  it("binds the Report Agent, and its repository_id column follows", async () => {
    const [row] = await rows<{
      repository_id: string | null;
      bound: string | null;
      owner: string | null;
    }>(`
      select repository_id,
             (metadata::jsonb #>> '{githubRepo,repositoryId}') as bound,
             (metadata::jsonb #>> '{githubRepo,owner}') as owner
        from connections where id = 'commerce-discovery_${ORG_LINKED}'`);
    expect(row?.repository_id).toBe("repo_215_linked");
    expect(row?.bound).toBe("repo_215_linked");
    // Expand, not rewrite: what the old reader reads is still there.
    expect(row?.owner).toBe("acme");
  });

  it("leaves a state that already names a repository exactly as it was", async () => {
    const [row] = await rows<{ repository_id: string | null }>(`
      select (configuration_state::jsonb #>> '{repository,repository_id}') as repository_id
        from connections where id = '${ORG_DONE}_commerce-discovery'`);
    expect(row?.repository_id).toBe("repo_215_done");
  });

  it("does not overrule an agent bound to a different repository", async () => {
    const [row] = await rows<{ repository_id: string | null }>(`
      select repository_id from connections
       where id = 'commerce-discovery_${ORG_DONE}'`);
    expect(row?.repository_id).toBeNull();
  });

  it("skips a github_repo that is not owner/name, and unparseable metadata", async () => {
    const [cd] = await rows<{ repository_id: string | null }>(`
      select (configuration_state::jsonb #>> '{repository,repository_id}') as repository_id
        from connections where id = '${ORG_BROKEN}_commerce-discovery'`);
    expect(cd?.repository_id).toBeNull();

    const [agent] = await rows<{ repository_id: string | null }>(`
      select repository_id from connections
       where id = 'commerce-discovery_${ORG_BROKEN}'`);
    expect(agent?.repository_id).toBeNull();

    const created = await rows(`
      select id from repositories where organization_id = '${ORG_BROKEN}'`);
    expect(created).toHaveLength(0);
  });

  it("is a no-op on a second run", async () => {
    const before = await rows(`select id from repositories`);
    await up(database.db as never);
    const after = await rows(`select id from repositories`);
    expect(after).toHaveLength(before.length);
  });

  it("down removes the reference and leaves the string and the rows", async () => {
    await down(database.db as never);

    const [cd] = await rows<{
      repository: unknown;
      github_repo: string | null;
    }>(`
      select (configuration_state::jsonb -> 'repository') as repository,
             (configuration_state::jsonb ->> 'github_repo') as github_repo
        from connections where id = '${ORG_LINKED}_commerce-discovery'`);
    expect(cd?.repository).toBeNull();
    expect(cd?.github_repo).toBe("acme/storefront");

    const [agent] = await rows<{
      repository_id: string | null;
      owner: string | null;
    }>(`
      select repository_id, (metadata::jsonb #>> '{githubRepo,owner}') as owner
        from connections where id = 'commerce-discovery_${ORG_LINKED}'`);
    expect(agent?.repository_id).toBeNull();
    expect(agent?.owner).toBe("acme");

    const kept = await rows(
      `select id from repositories where id = 'repo_215_linked'`,
    );
    expect(kept).toHaveLength(1);
  });
});
