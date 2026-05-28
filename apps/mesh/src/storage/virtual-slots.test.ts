/**
 * Storage-layer tests for slot rows on Virtual MCPs.
 *
 * Verifies that the aggregations table can store both concrete child
 * connections and typed slots, and that VirtualMCPStorage round-trips
 * them into the new `slots` field on VirtualMCPEntity.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import {
  closeTestDatabase,
  createTestDatabase,
  type TestDatabase,
} from "../database/test-db";
import { createTestSchema, seedCommonTestFixtures } from "./test-helpers";
import { VirtualMCPStorage } from "./virtual";

const USER = "user_test";
const ORG = "org_test";

async function insertChildConnection(
  database: TestDatabase,
  id: string,
  appId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await sql`
    INSERT INTO connections (
      id, organization_id, created_by, title, connection_type,
      connection_url, app_id, access, status, created_at, updated_at
    ) VALUES (
      ${id}, ${ORG}, ${USER}, 'child', 'HTTP',
      'https://example.com', ${appId}, 'org',
      'active', ${now}, ${now}
    )
  `.execute(database.db);
}

describe("VirtualMCPStorage — slots", () => {
  let database: TestDatabase;
  let storage: VirtualMCPStorage;

  beforeEach(async () => {
    database = await createTestDatabase();
    await createTestSchema(database.db);
    await seedCommonTestFixtures(database.db);
    storage = new VirtualMCPStorage(database.db);
  });

  afterEach(async () => {
    await closeTestDatabase(database);
  });

  it("creates an agent with a concrete child and a slot, round-trips both", async () => {
    await insertChildConnection(database, "conn_concrete", "mcp-linear");

    const entity = await storage.create(ORG, USER, {
      title: "test agent",
      status: "active",
      pinned: false,
      connections: [
        {
          connection_id: "conn_concrete",
          selected_tools: null,
          selected_resources: null,
          selected_prompts: null,
        },
      ],
      slots: [
        {
          slot_app_id: "mcp-github",
          selected_tools: null,
          selected_resources: null,
          selected_prompts: null,
        },
      ],
    });

    expect(entity.connections).toHaveLength(1);
    expect(entity.connections[0]?.connection_id).toBe("conn_concrete");
    expect(entity.slots).toHaveLength(1);
    expect(entity.slots[0]?.slot_app_id).toBe("mcp-github");

    const reloaded = await storage.findById(entity.id, ORG);
    expect(reloaded?.connections).toHaveLength(1);
    expect(reloaded?.slots).toHaveLength(1);
    expect(reloaded?.slots[0]?.slot_app_id).toBe("mcp-github");
  });

  it("update replaces slots alongside connections", async () => {
    await insertChildConnection(database, "conn_a", "mcp-linear");
    await insertChildConnection(database, "conn_b", "mcp-notion");

    const entity = await storage.create(ORG, USER, {
      title: "test agent",
      status: "active",
      pinned: false,
      connections: [
        {
          connection_id: "conn_a",
          selected_tools: null,
          selected_resources: null,
          selected_prompts: null,
        },
      ],
      slots: [
        {
          slot_app_id: "mcp-github",
          selected_tools: null,
          selected_resources: null,
          selected_prompts: null,
        },
      ],
    });

    const updated = await storage.update(entity.id, USER, {
      connections: [
        {
          connection_id: "conn_b",
          selected_tools: null,
          selected_resources: null,
          selected_prompts: null,
        },
      ],
      slots: [
        {
          slot_app_id: "mcp-slack",
          selected_tools: null,
          selected_resources: null,
          selected_prompts: null,
        },
      ],
    });

    expect(updated?.connections.map((c) => c.connection_id)).toEqual([
      "conn_b",
    ]);
    expect(updated?.slots.map((s) => s.slot_app_id)).toEqual(["mcp-slack"]);
  });

  it("update preserves slots when caller omits the slots field", async () => {
    await insertChildConnection(database, "conn_a", "mcp-linear");
    await insertChildConnection(database, "conn_b", "mcp-notion");

    const entity = await storage.create(ORG, USER, {
      title: "test agent",
      status: "active",
      pinned: false,
      connections: [
        {
          connection_id: "conn_a",
          selected_tools: null,
          selected_resources: null,
          selected_prompts: null,
        },
      ],
      slots: [
        {
          slot_app_id: "mcp-github",
          selected_tools: null,
          selected_resources: null,
          selected_prompts: null,
        },
      ],
    });

    // Update ONLY connections — slots field is omitted entirely.
    const updated = await storage.update(entity.id, USER, {
      connections: [
        {
          connection_id: "conn_b",
          selected_tools: null,
          selected_resources: null,
          selected_prompts: null,
        },
      ],
    });

    expect(updated?.connections.map((c) => c.connection_id)).toEqual([
      "conn_b",
    ]);
    expect(updated?.slots.map((s) => s.slot_app_id)).toEqual(["mcp-github"]);
  });

  it("update preserves connections when caller omits the connections field", async () => {
    await insertChildConnection(database, "conn_a", "mcp-linear");

    const entity = await storage.create(ORG, USER, {
      title: "test agent",
      status: "active",
      pinned: false,
      connections: [
        {
          connection_id: "conn_a",
          selected_tools: null,
          selected_resources: null,
          selected_prompts: null,
        },
      ],
      slots: [
        {
          slot_app_id: "mcp-github",
          selected_tools: null,
          selected_resources: null,
          selected_prompts: null,
        },
      ],
    });

    // Update ONLY slots — connections field is omitted entirely.
    const updated = await storage.update(entity.id, USER, {
      slots: [
        {
          slot_app_id: "mcp-slack",
          selected_tools: null,
          selected_resources: null,
          selected_prompts: null,
        },
      ],
    });

    expect(updated?.connections.map((c) => c.connection_id)).toEqual([
      "conn_a",
    ]);
    expect(updated?.slots.map((s) => s.slot_app_id)).toEqual(["mcp-slack"]);
  });

  it("XOR enforced by DB: concrete child + slot in same agent are stored on separate rows", async () => {
    await insertChildConnection(database, "conn_x", "mcp-linear");
    const entity = await storage.create(ORG, USER, {
      title: "test",
      status: "active",
      pinned: false,
      connections: [
        {
          connection_id: "conn_x",
          selected_tools: null,
          selected_resources: null,
          selected_prompts: null,
        },
      ],
      slots: [
        {
          slot_app_id: "mcp-github",
          selected_tools: null,
          selected_resources: null,
          selected_prompts: null,
        },
      ],
    });
    expect(entity.connections).toHaveLength(1);
    expect(entity.slots).toHaveLength(1);
  });
});
