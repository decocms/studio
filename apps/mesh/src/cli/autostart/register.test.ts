import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeTestDatabase,
  createTestDatabase,
  type TestDatabase,
} from "../../database/test-db";
import { CredentialVault } from "../../encryption/credential-vault";
import { ConnectionStorage } from "../../storage/connection";
import {
  createTestSchema,
  seedCommonTestFixtures,
} from "../../storage/test-helpers";
import { VirtualMCPStorage } from "../../storage/virtual";
import type { DetectedProject } from "./detect";
import { registerProjectAsAgent } from "./register";

describe("registerProjectAsAgent", () => {
  let database: TestDatabase;
  let connections: ConnectionStorage;
  let virtualMcps: VirtualMCPStorage;

  const project: DetectedProject = {
    root: mkdtempSync(join(tmpdir(), "autostart-register-")),
    name: "demo",
    packageManager: "bun",
    starter: "dev",
    description: "demo project",
    readmePreview: "# demo\n\nA cool MCP",
    promptFile: null,
  };

  beforeAll(async () => {
    database = await createTestDatabase();
    const vault = new CredentialVault(CredentialVault.generateKey());
    connections = new ConnectionStorage(database.db, vault);
    virtualMcps = new VirtualMCPStorage(database.db);
    await createTestSchema(database.db);
    await seedCommonTestFixtures(database.db);
  });

  afterAll(async () => {
    await closeTestDatabase(database);
  });

  it("creates a deterministic connection + virtual mcp on first run", async () => {
    const result = await registerProjectAsAgent({
      connections,
      virtualMcps,
      organizationId: "org_1",
      userId: "user_1",
      project,
      mcpUrl: "http://localhost:3001/mcp",
      instructions: "do things",
    });
    expect(result.isNew).toBe(true);
    expect(result.connectionId).toMatch(/^conn_auto_/);
    expect(result.virtualMcpId).toMatch(/^vir_auto_/);

    const conn = await connections.findById(result.connectionId);
    expect(conn?.connection_url).toBe("http://localhost:3001/mcp");
    expect(conn?.connection_type).toBe("HTTP");

    const agent = await virtualMcps.findById(result.virtualMcpId, "org_1");
    expect(agent?.title).toBe("demo");
    expect(agent?.metadata?.instructions).toBe("do things");
    expect(agent?.connections).toHaveLength(1);
    expect(agent?.connections[0]?.connection_id).toBe(result.connectionId);
  });

  it("is idempotent on second run with the same path", async () => {
    const first = await registerProjectAsAgent({
      connections,
      virtualMcps,
      organizationId: "org_1",
      userId: "user_1",
      project,
      mcpUrl: "http://localhost:3001/mcp",
      instructions: "do things",
    });
    const second = await registerProjectAsAgent({
      connections,
      virtualMcps,
      organizationId: "org_1",
      userId: "user_1",
      project,
      mcpUrl: "http://localhost:3002/mcp", // port changed
      instructions: "do other things", // ignored on re-run (instructions present)
    });
    expect(second.connectionId).toBe(first.connectionId);
    expect(second.virtualMcpId).toBe(first.virtualMcpId);
    expect(second.isNew).toBe(false);

    // URL refreshed to new port
    const conn = await connections.findById(second.connectionId);
    expect(conn?.connection_url).toBe("http://localhost:3002/mcp");

    // Existing instructions preserved
    const agent = await virtualMcps.findById(second.virtualMcpId, "org_1");
    expect(agent?.metadata?.instructions).toBe("do things");
  });
});
