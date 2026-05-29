import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../database/test-db-pg";
import type { MeshDatabase } from "../database";
import { ConnectionStorage } from "./connection";
import { CredentialVault } from "../encryption/credential-vault";

const USER = "user_test";
const ORG = "org_test";

describe("ConnectionStorage — app_id derivation", () => {
  let database: MeshDatabase;
  let storage: ConnectionStorage;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    const vault = new CredentialVault(CredentialVault.generateKey());
    storage = new ConnectionStorage(database.db, vault);
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
  });

  it("fills a synthetic app_id on create when none is provided", async () => {
    const conn = await storage.create({
      organization_id: ORG,
      created_by: USER,
      title: "custom",
      connection_type: "HTTP",
      connection_url: "https://API.Example.com/mcp/?token=x",
    });
    expect(conn.app_id).toBe("url:api.example.com/mcp");
  });

  it("preserves a registry app_id on create", async () => {
    const conn = await storage.create({
      organization_id: ORG,
      created_by: USER,
      title: "gh",
      connection_type: "HTTP",
      connection_url: "https://api.github.com/mcp",
      app_id: "deco/mcp-github",
    });
    expect(conn.app_id).toBe("deco/mcp-github");
  });
});
