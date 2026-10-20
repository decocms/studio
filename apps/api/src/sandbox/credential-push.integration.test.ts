import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { ListedTenantPool } from "@decocms/sandbox/provider/sandbox-api";
import type { StudioDatabase } from "@/database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "@/database/test-db-pg";
import { RepositoryStorage } from "@/storage/repositories";
import { credentialRecords, planCredentialPush } from "./credential-push";

describe("the credential push for listed tenant pools", () => {
  let database: StudioDatabase;
  let siteId: string;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    const repositories = new RepositoryStorage(database.db);
    siteId = (
      await repositories.upsert({
        organizationId: "org_1",
        ref: { provider: "github", host: "github.com", path: "Acme/Site" },
      })
    ).id;
    await repositories.upsert({
      organizationId: "org_123",
      ref: { provider: "github", host: "github.com", path: "acme/docs" },
    });
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  async function planFor(pools: ListedTenantPool[]) {
    return planCredentialPush({
      sandboxes: [],
      pools,
      records: await credentialRecords(database.db, [], pools),
      now: Date.now(),
    });
  }

  const pool = (tenant: string, repoUrl: string): ListedTenantPool => ({
    name: "p",
    tenant,
    image: "default",
    repos: [{ repoUrl, branch: "main" }],
  });

  it("mints from the pool org's own record, whatever the URL's case or suffix", async () => {
    expect(
      await planFor([pool("org_1", "https://github.com/acme/site.git")]),
    ).toMatchObject({
      poolClones: [
        {
          tenant: "org_1",
          repoUrl: "https://github.com/acme/site.git",
          repositoryId: siteId,
        },
      ],
      refused: 0,
    });
  });

  it("pushes nothing for a repo the pool's org has no record of", async () => {
    expect(
      await planFor([pool("org_1", "https://github.com/acme/unknown")]),
    ).toMatchObject({ poolClones: [], refused: 1 });
  });

  it("refuses another org's record for the same repo", async () => {
    expect(
      await planFor([
        pool("org_1", "https://github.com/acme/docs"),
        pool("org_456", "https://github.com/acme/site"),
      ]),
    ).toMatchObject({ poolClones: [], refused: 2 });
  });
});
