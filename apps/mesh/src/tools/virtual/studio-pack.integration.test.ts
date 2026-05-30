import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { StudioPackAgentId, WellKnownOrgMCPId } from "@decocms/mesh-sdk";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../../database/test-db-pg";
import type { MeshDatabase } from "../../database";
import { CredentialVault } from "../../encryption/credential-vault";
import { ConnectionStorage } from "../../storage/connection";
import { VirtualMCPStorage } from "../../storage/virtual";
import { installStudioPack } from "./studio-pack";

describe("installStudioPack", () => {
  let database: MeshDatabase;
  let virtualMcpStorage: VirtualMCPStorage;
  let connectionStorage: ConnectionStorage;
  const orgId = "org_studio_pack_test";
  const userId = "user_studio_pack_test";

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    virtualMcpStorage = new VirtualMCPStorage(database.db);
    const vault = new CredentialVault(CredentialVault.generateKey());
    connectionStorage = new ConnectionStorage(database.db, vault);

    // Seed the org and user required by FK constraints on the connections table.
    // emailVerified is BOOLEAN in real PG (Better Auth); raw SQL so the
    // Database schema type's stale `number` doesn't get in the way.
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${userId}, ${userId + "@test.com"}, false, ${"Test " + userId}, ${now}, ${now})
      ON CONFLICT (id) DO NOTHING
    `.execute(database.db);
    await sql`
      INSERT INTO "organization" (id, name, slug, "createdAt")
      VALUES (${orgId}, ${orgId}, ${orgId}, ${now})
      ON CONFLICT (id) DO NOTHING
    `.execute(database.db);

    // Seed the well-known HTTP connections the pack agents reference.
    await connectionStorage.create({
      id: WellKnownOrgMCPId.SELF(orgId),
      organization_id: orgId,
      created_by: userId,
      title: "Deco CMS",
      description: "self",
      connection_type: "HTTP",
      connection_url: "https://example.invalid/mcp/self",
      connection_token: null,
    });
    await connectionStorage.create({
      id: WellKnownOrgMCPId.REGISTRY(orgId),
      organization_id: orgId,
      created_by: userId,
      title: "Deco Store",
      description: "registry",
      connection_type: "HTTP",
      connection_url: "https://example.invalid/mcp/registry",
      connection_token: null,
    });
    await connectionStorage.create({
      id: WellKnownOrgMCPId.COMMUNITY_REGISTRY(orgId),
      organization_id: orgId,
      created_by: userId,
      title: "MCP Registry",
      description: "community",
      connection_type: "HTTP",
      connection_url: "https://example.invalid/mcp/community",
      connection_token: null,
    });
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  test("creates all four studio-pack agents on a fresh org", async () => {
    await installStudioPack(orgId, userId, virtualMcpStorage);

    for (const getId of [
      StudioPackAgentId.AGENT_MANAGER,
      StudioPackAgentId.AUTOMATION_MANAGER,
      StudioPackAgentId.CONNECTION_MANAGER,
      StudioPackAgentId.STORE_MANAGER,
    ]) {
      const found = await virtualMcpStorage.findById(getId(orgId), orgId);
      expect(found).not.toBeNull();
      expect(found?.title).toBeTruthy();
    }
  });

  test("is idempotent — calling twice does not create duplicates", async () => {
    await installStudioPack(orgId, userId, virtualMcpStorage);
    await installStudioPack(orgId, userId, virtualMcpStorage);

    const storeId = StudioPackAgentId.STORE_MANAGER(orgId);
    const matches = await virtualMcpStorage.list(orgId);
    const stores = matches.filter((m) => m.id === storeId);
    expect(stores.length).toBe(1);
  });

  test("Store Manager aggregates registry and community-registry", async () => {
    await installStudioPack(orgId, userId, virtualMcpStorage);
    const storeId = StudioPackAgentId.STORE_MANAGER(orgId);
    const store = await virtualMcpStorage.findById(storeId, orgId);
    expect(store).not.toBeNull();
    const connIds = (store?.connections ?? [])
      .map((c) => c.connection_id)
      .sort();
    expect(connIds).toEqual(
      [
        WellKnownOrgMCPId.REGISTRY(orgId),
        WellKnownOrgMCPId.COMMUNITY_REGISTRY(orgId),
      ].sort(),
    );
  });

  test("legacy managers still bind to the self connection", async () => {
    await installStudioPack(orgId, userId, virtualMcpStorage);
    const agentId = StudioPackAgentId.AGENT_MANAGER(orgId);
    const agent = await virtualMcpStorage.findById(agentId, orgId);
    const connIds = (agent?.connections ?? []).map((c) => c.connection_id);
    expect(connIds).toEqual([WellKnownOrgMCPId.SELF(orgId)]);
  });
});
