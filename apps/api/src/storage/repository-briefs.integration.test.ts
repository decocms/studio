import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { sql } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../database/test-db-pg";
import type { StudioDatabase } from "../database";
import { RepositoryStorage } from "./repositories";
import { RepositoryBriefStorage } from "./repository-briefs";

const ON = "org_1";
const OFF = "org_123";
const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-10-18T12:00:00Z");
const STALE_BEFORE = new Date(NOW.getTime() - 24 * HOUR);
const RETRY_BEFORE = new Date(NOW.getTime() - HOUR);
const BRIEF = {
  purpose: "A storefront.",
  activeAreas: [],
  abandonedAreas: [],
  conventions: [],
};

describe("RepositoryBriefStorage", () => {
  let database: StudioDatabase;
  let briefs: RepositoryBriefStorage;
  let repositories: RepositoryStorage;

  const link = async (organizationId: string, path: string, bound = true) => {
    const repo = await repositories.upsert({
      organizationId,
      ref: { provider: "github", host: "github.com", path },
    });
    if (bound) {
      const id = `vmcp_${path.replace("/", "_")}`;
      const now = new Date().toISOString();
      await database.db
        .insertInto("connections")
        .values({
          id,
          organization_id: organizationId,
          created_by: "user_1",
          updated_by: null,
          title: id,
          description: null,
          icon: null,
          app_name: null,
          app_id: null,
          slug: null,
          connection_type: "VIRTUAL",
          connection_url: `virtual://${id}`,
          connection_token: null,
          connection_headers: null,
          oauth_config: null,
          configuration_state: null,
          configuration_scopes: null,
          metadata: JSON.stringify({}),
          bindings: null,
          status: "active",
          pinned: false,
          repository_id: repo.id,
          created_at: now,
          updated_at: now,
        })
        .execute();
    }
    return repo.id;
  };

  const due = async () =>
    (await briefs.listDue(STALE_BEFORE, RETRY_BEFORE, 50)).map(
      (d) => d.repositoryId,
    );

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    briefs = new RepositoryBriefStorage(database.db);
    repositories = new RepositoryStorage(database.db);
    const now = new Date().toISOString();
    await sql`
      INSERT INTO organization_settings ("organizationId", flags, "createdAt", "updatedAt")
      VALUES (${ON}, '{"repo_upkeep": true}'::jsonb, ${now}, ${now}),
             (${OFF}, '{"repo_upkeep": false}'::jsonb, ${now}, ${now})
    `.execute(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  beforeEach(async () => {
    await database.db.deleteFrom("repository_briefs").execute();
    await database.db.deleteFrom("connections").execute();
    await database.db.deleteFrom("repositories").execute();
  });

  it("lists only project-bound repositories in orgs with the flag on", async () => {
    const bound = await link(ON, "acme/bound");
    await link(ON, "acme/unbound", false);
    await link(OFF, "other/bound");
    expect(await due()).toEqual([bound]);
  });

  it("skips a fresh brief and returns a stale one", async () => {
    const fresh = await link(ON, "acme/fresh");
    const stale = await link(ON, "acme/stale");
    await briefs.saveBuilt(
      ON,
      fresh,
      "a",
      BRIEF,
      new Date(NOW.getTime() - HOUR),
    );
    await briefs.saveBuilt(
      ON,
      stale,
      "b",
      BRIEF,
      new Date(NOW.getTime() - 25 * HOUR),
    );
    expect(await due()).toEqual([stale]);
  });

  it("waits out a recent failure, then retries", async () => {
    const recent = await link(ON, "acme/recent");
    const old = await link(ON, "acme/old");
    await briefs.recordFailure(
      ON,
      recent,
      "403",
      new Date(NOW.getTime() - 10 * 60 * 1000),
    );
    await briefs.recordFailure(
      ON,
      old,
      "403",
      new Date(NOW.getTime() - 2 * HOUR),
    );
    expect(await due()).toEqual([old]);
  });

  it("puts never-attempted repositories first and honors the cap", async () => {
    const attempted = await link(ON, "acme/attempted");
    await briefs.recordFailure(
      ON,
      attempted,
      "x",
      new Date(NOW.getTime() - 2 * HOUR),
    );
    const fresh = await link(ON, "acme/new");
    expect(await due()).toEqual([fresh, attempted]);
    expect(await briefs.listDue(STALE_BEFORE, RETRY_BEFORE, 1)).toHaveLength(1);
  });

  it("a failure never replaces a good brief", async () => {
    const id = await link(ON, "acme/site");
    const builtAt = new Date(NOW.getTime() - 25 * HOUR);
    await briefs.saveBuilt(ON, id, "abc", BRIEF, builtAt);
    await briefs.recordFailure(ON, id, "rate limited", NOW);
    const row = await briefs.get(id, ON);
    expect(row?.brief).toEqual(BRIEF);
    expect(row?.headSha).toBe("abc");
    expect(row?.builtAt?.toISOString()).toBe(builtAt.toISOString());
    expect(row?.attemptedAt.toISOString()).toBe(NOW.toISOString());
    expect(row?.error).toBe("rate limited");
  });

  it("markCurrent refreshes a good brief and clears the error", async () => {
    const id = await link(ON, "acme/site");
    await briefs.saveBuilt(
      ON,
      id,
      "abc",
      BRIEF,
      new Date(NOW.getTime() - 25 * HOUR),
    );
    await briefs.recordFailure(
      ON,
      id,
      "flaky",
      new Date(NOW.getTime() - 2 * HOUR),
    );
    await briefs.markCurrent(ON, id, NOW);
    const row = await briefs.get(id, ON);
    expect(row?.builtAt?.toISOString()).toBe(NOW.toISOString());
    expect(row?.error).toBeNull();
  });

  it("markCurrent does not invent a brief for a failure-only row", async () => {
    const id = await link(ON, "acme/site");
    await briefs.recordFailure(
      ON,
      id,
      "403",
      new Date(NOW.getTime() - 2 * HOUR),
    );
    await briefs.markCurrent(ON, id, NOW);
    const row = await briefs.get(id, ON);
    expect(row?.builtAt).toBeNull();
    expect(row?.error).toBe("403");
  });

  it("get is scoped to the organization", async () => {
    const id = await link(ON, "acme/site");
    await briefs.saveBuilt(ON, id, "abc", BRIEF, NOW);
    expect(await briefs.get(id, OFF)).toBeNull();
  });

  it("the brief is deleted with its repository", async () => {
    const id = await link(ON, "acme/site");
    await briefs.saveBuilt(ON, id, "abc", BRIEF, NOW);
    await database.db.deleteFrom("connections").execute();
    await database.db.deleteFrom("repositories").where("id", "=", id).execute();
    expect(await briefs.get(id, ON)).toBeNull();
  });
});
