import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { StudioPackAgentId, WellKnownOrgMCPId } from "@decocms/shared/sdk";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../../database/test-db-pg";
import type { StudioDatabase } from "../../database";
import { CredentialVault } from "../../encryption/credential-vault";
import { ConnectionStorage } from "../../storage/connection";
import { VirtualMCPStorage } from "../../storage/virtual";
import { installStudioPack, STUDIO_PACK_AGENTS } from "./studio-pack";

describe("installStudioPack", () => {
  let database: StudioDatabase;
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

  test("creates the studio-pack agents on a fresh org", async () => {
    await installStudioPack(orgId, userId, virtualMcpStorage);

    for (const manager of STUDIO_PACK_AGENTS) {
      const found = await virtualMcpStorage.findById(
        manager.getId(orgId),
        orgId,
      );
      expect(found).not.toBeNull();
      expect(found?.title).toBe(manager.title);
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

  test("API Key Manager exposes only key management and read-only discovery tools", async () => {
    await installStudioPack(orgId, userId, virtualMcpStorage);
    const managerId = StudioPackAgentId.API_KEY_MANAGER(orgId);
    const manager = await virtualMcpStorage.findById(managerId, orgId);

    expect(manager?.connections).toHaveLength(1);
    expect(manager?.connections[0]?.connection_id).toBe(
      WellKnownOrgMCPId.SELF(orgId),
    );
    expect(manager?.connections[0]?.selected_tools).toEqual([
      "API_KEY_CREATE",
      "API_KEY_LIST",
      "API_KEY_UPDATE",
      "API_KEY_DELETE",
      "COLLECTION_VIRTUAL_MCP_LIST",
      "COLLECTION_VIRTUAL_MCP_GET",
      "COLLECTION_CONNECTIONS_LIST",
      "COLLECTION_CONNECTIONS_GET",
    ]);
  });

  test("deletes a previously-installed Task Manager", async () => {
    const retiredId = `studio-task-manager_${orgId}`;
    await virtualMcpStorage.create(
      orgId,
      userId,
      {
        title: "Task Manager",
        description: "retired",
        icon: "icon://Flag01",
        status: "active",
        pinned: false,
        metadata: {},
        connections: [],
      },
      { id: retiredId },
    );

    await installStudioPack(orgId, userId, virtualMcpStorage);

    expect(await virtualMcpStorage.findById(retiredId, orgId)).toBeNull();
  });

  test("overwrites stale tool selections on an existing API Key Manager", async () => {
    await installStudioPack(orgId, userId, virtualMcpStorage);
    const managerId = StudioPackAgentId.API_KEY_MANAGER(orgId);

    await virtualMcpStorage.update(managerId, userId, {
      metadata: {
        instructions: "Never reproduce the key value in your response.",
      },
      connections: [
        {
          connection_id: WellKnownOrgMCPId.SELF(orgId),
          selected_tools: ["COLLECTION_CONNECTIONS_LIST"],
          selected_resources: null,
          selected_prompts: null,
        },
      ],
    });

    await installStudioPack(orgId, userId, virtualMcpStorage);
    const manager = await virtualMcpStorage.findById(managerId, orgId);

    expect(manager?.connections[0]?.selected_tools).toEqual([
      "API_KEY_CREATE",
      "API_KEY_LIST",
      "API_KEY_UPDATE",
      "API_KEY_DELETE",
      "COLLECTION_VIRTUAL_MCP_LIST",
      "COLLECTION_VIRTUAL_MCP_GET",
      "COLLECTION_CONNECTIONS_LIST",
      "COLLECTION_CONNECTIONS_GET",
    ]);
    expect(manager?.metadata?.instructions).toContain(
      "Print that value once in a fenced plain-text code block",
    );
  });
});
