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

  it("re-derives a synthetic app_id when the url changes on update", async () => {
    const conn = await storage.create({
      organization_id: ORG,
      created_by: USER,
      title: "custom",
      connection_type: "HTTP",
      connection_url: "https://old.com/mcp",
    });
    expect(conn.app_id).toBe("url:old.com/mcp");

    const updated = await storage.update(conn.id, {
      connection_url: "https://new.com/mcp",
    });
    expect(updated.app_id).toBe("url:new.com/mcp");
  });

  it("never re-derives a real registry app_id on update", async () => {
    const conn = await storage.create({
      organization_id: ORG,
      created_by: USER,
      title: "gh",
      connection_type: "HTTP",
      connection_url: "https://api.github.com/mcp",
      app_id: "deco/mcp-github",
    });

    const updated = await storage.update(conn.id, {
      connection_url: "https://api.github.com/v2/mcp",
    });
    expect(updated.app_id).toBe("deco/mcp-github");
  });

  it("rejects a second private connection to the same service for the same user", async () => {
    await storage.create({
      organization_id: ORG,
      created_by: USER,
      title: "first",
      connection_type: "HTTP",
      connection_url: "https://dup.com/mcp",
    });

    await expect(
      storage.create({
        organization_id: ORG,
        created_by: USER,
        title: "second",
        connection_type: "HTTP",
        connection_url: "https://dup.com/mcp",
      }),
    ).rejects.toThrow(/only one private connection per user/i);
  });
});
