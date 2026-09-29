import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../database/test-db-pg";
import { CredentialVault } from "../encryption/credential-vault";
import { ConnectionStorage } from "./connection";
import { VirtualMCPStorage } from "./virtual";
import { SqlThreadStorage } from "./threads";
import { RepositoryStorage } from "./repositories";

const org = "org_123";
const user = "user_123";
const binding = (host: string) => ({
  owner: "example",
  name: "site",
  url: `https://${host}/example/site`,
});

describe("repository binding persistence", () => {
  let database: StudioDatabase;
  let projects: VirtualMCPStorage;
  let connections: ConnectionStorage;
  let threads: SqlThreadStorage;
  let repositories: RepositoryStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    projects = new VirtualMCPStorage(database.db);
    connections = new ConnectionStorage(
      database.db,
      new CredentialVault(CredentialVault.generateKey()),
    );
    threads = new SqlThreadStorage(database.db);
    repositories = new RepositoryStorage(database.db);
  });
  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  test("project create, generic connection reads, updates, and unlink use one stored representation", async () => {
    const repository = await repositories.upsert({
      organizationId: org,
      ref: { provider: "gitlab", host: "gitlab.com", path: "example/site" },
    });
    const repo = { ...binding("gitlab.com"), repositoryId: repository.id };
    const project = await projects.create(org, user, {
      title: "Synthetic site",
      status: "active",
      pinned: false,
      connections: [],
      metadata: { repository: repo },
    });
    expect(project.metadata?.repository).toEqual(repo);
    expect(
      (await connections.findById(project.id, org))?.metadata,
    ).toMatchObject({ repository: repo });
    const stored = await database.db
      .selectFrom("connections")
      .select(["metadata", "repository_id"])
      .where("id", "=", project.id)
      .where("organization_id", "=", org)
      .executeTakeFirstOrThrow();
    // Compatibility: inspect stored bytes, not just the decoded application object.
    expect(JSON.parse(String(stored.metadata))).toMatchObject({
      githubRepo: repo,
    });
    expect(stored.metadata).not.toContain('"repository":');
    expect(stored.repository_id).toBe(repository.id);
    const updated = await connections.update(project.id, {
      metadata: { repository: repo, marker: true },
    });
    expect(updated.metadata).toEqual({ repository: repo, marker: true });
    expect(
      (await projects.findById(project.id, org))?.metadata?.repository,
    ).toEqual(repo);
    await projects.update(project.id, user, {
      metadata: { repository: null, marker: true },
    });
    expect(
      (await connections.findById(project.id, org))?.metadata,
    ).toMatchObject({ repository: null });
    const cleared = await database.db
      .selectFrom("connections")
      .select(["metadata", "repository_id"])
      .where("id", "=", project.id)
      .where("organization_id", "=", org)
      .executeTakeFirstOrThrow();
    expect(JSON.parse(String(cleared.metadata))).toEqual({
      githubRepo: null,
      marker: true,
    });
    expect(cleared.repository_id).toBeNull();
  });

  test("outdated client metadata cannot erase an existing repository binding", async () => {
    const repository = await repositories.upsert({
      organizationId: org,
      ref: { provider: "github", host: "github.com", path: "example/legacy" },
    });
    const repo = { ...binding("github.com"), repositoryId: repository.id };
    const project = await projects.create(org, user, {
      title: "Legacy-shaped input",
      status: "active",
      pinned: false,
      connections: [],
      metadata: { repository: repo },
    });
    // Compatibility keys are accepted only when reading database rows.
    await expect(
      connections.update(project.id, {
        metadata: { githubRepo: repo },
      }),
    ).rejects.toThrow("database compatibility key");
    const stored = await database.db
      .selectFrom("connections")
      .select(["metadata", "repository_id"])
      .where("id", "=", project.id)
      .where("organization_id", "=", org)
      .executeTakeFirstOrThrow();
    expect(JSON.parse(String(stored.metadata))).toEqual({ githubRepo: repo });
    expect(stored.repository_id).toBe(repository.id);
  });

  test("patching mixed-format rows replaces or clears both binding spellings", async () => {
    const repository = await repositories.upsert({
      organizationId: org,
      ref: {
        provider: "gitlab",
        host: "gitlab.com",
        path: "example/replacement",
      },
    });
    const replacement = {
      ...binding("gitlab.com"),
      repositoryId: repository.id,
    };
    const project = await projects.create(org, user, {
      title: "Mixed-format site",
      status: "active",
      pinned: false,
      connections: [],
    });
    for (const clear of [false, true]) {
      // Compatibility: mixed physical rows must not revive stale canonical keys.
      await database.db
        .updateTable("connections")
        .set({
          metadata: JSON.stringify({
            repository: binding("github.com"),
            githubRepo: binding("github.com"),
            additionalRepositories: [binding("github.com")],
            githubRepos: [binding("github.com")],
            marker: true,
          }),
        })
        .where("id", "=", project.id)
        .where("organization_id", "=", org)
        .execute();
      await projects.patchMetadata({
        id: project.id,
        organizationId: org,
        by: user,
        set: clear
          ? {}
          : { repository: replacement, additionalRepositories: [replacement] },
        unset: clear ? ["repository", "additionalRepositories"] : [],
      });
      const stored = await database.db
        .selectFrom("connections")
        .select(["metadata", "repository_id"])
        .where("id", "=", project.id)
        .where("organization_id", "=", org)
        .executeTakeFirstOrThrow();
      expect(JSON.parse(String(stored.metadata))).toEqual(
        clear
          ? { marker: true }
          : {
              githubRepo: replacement,
              githubRepos: [replacement],
              marker: true,
            },
      );
      expect(stored.repository_id).toBe(clear ? null : repository.id);
      expect(
        (await projects.findById(project.id, org))?.metadata?.repository,
      ).toEqual(clear ? undefined : replacement);
    }
  });

  test("reads old rows and observes an old writer removing a binding", async () => {
    const project = await projects.create(org, user, {
      title: "Historical site",
      status: "active",
      pinned: false,
      connections: [],
    });
    // Compatibility: simulate the physical metadata an older replica writes.
    await database.db
      .updateTable("connections")
      .set({
        metadata: JSON.stringify({
          githubRepo: binding("bitbucket.org"),
          marker: 1,
        }),
      })
      .where("id", "=", project.id)
      .where("organization_id", "=", org)
      .execute();
    expect(
      (await projects.findById(project.id, org))?.metadata?.repository,
    ).toEqual(binding("bitbucket.org"));
    await database.db
      .updateTable("connections")
      .set({ metadata: JSON.stringify({ marker: 2 }) })
      .where("id", "=", project.id)
      .where("organization_id", "=", org)
      .execute();
    expect(
      (await projects.findById(project.id, org))?.metadata?.repository,
    ).toBeUndefined();
  });

  test("does not reinterpret arbitrary non-project connection metadata", async () => {
    const metadata = { repository: { custom: "integration-owned" } };
    const connection = await connections.create({
      title: "Synthetic connector",
      organization_id: org,
      created_by: user,
      connection_type: "HTTP",
      connection_url: "https://example.com/mcp",
      metadata,
    });
    expect(connection.metadata).toEqual(metadata);
    expect(
      (await connections.update(connection.id, { metadata }))?.metadata,
    ).toEqual(metadata);
  });

  test("thread bindings round-trip and explicit removal persists", async () => {
    const thread = await threads.create({
      organization_id: org,
      created_by: user,
      title: "Synthetic task",
      metadata: { repository: binding("gitlab.com"), marker: 1 },
    });
    expect(thread.metadata?.repository).toEqual(binding("gitlab.com"));
    expect(thread.metadata).not.toHaveProperty("githubRepo");
    const stored = await database.db
      .selectFrom("threads")
      .select("metadata")
      .where("id", "=", thread.id)
      .where("organization_id", "=", org)
      .executeTakeFirstOrThrow();
    expect(stored.metadata).toEqual({
      githubRepo: binding("gitlab.com"),
      marker: 1,
    });
    await threads.update(thread.id, org, { metadata: { marker: 2 } });
    expect((await threads.get(thread.id, org))?.metadata).toEqual({
      marker: 2,
    });
  });
});
