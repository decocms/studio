/**
 * Integration tests for slot resolution at virtual MCP client construction.
 *
 * Exercises the wiring in `createVirtualClientFrom` end-to-end against a
 * real Kysely DB and the real ConnectionStorage. The PassthroughClient is
 * constructed for real but never opened — we only verify what it sees on
 * its `options.connections` and `options.virtualMcp.connections` arrays,
 * which is what downstream tool dispatch routes by.
 *
 * Scenarios:
 *   1. Agent has a slot. Caller has a matching user-private connection.
 *      -> Slot resolves to caller's connection; createVirtualClientFrom
 *         succeeds and the resolved connection appears in both arrays.
 *   2. Agent has a slot. Caller has only an org-shared matching connection.
 *      -> Slot falls back to the org-shared one.
 *   3. Agent has a slot. Caller has nothing matching.
 *      -> createVirtualClientFrom throws SlotUnresolvedError carrying
 *         the missing app_id.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { trace } from "@opentelemetry/api";
import { sql } from "kysely";
import { ConnectionStorage } from "../../storage/connection";
import { CredentialVault } from "../../encryption/credential-vault";
import { VirtualMCPStorage } from "../../storage/virtual";
import {
  closeTestDatabase,
  createTestDatabase,
  type TestDatabase,
} from "../../database/test-db";
import {
  createTestSchema,
  seedCommonTestFixtures,
} from "../../storage/test-helpers";
import { SlotUnresolvedError } from "../../core/slot-resolver";
import type { MeshContext } from "../../core/mesh-context";
import { createVirtualClientFrom } from "./index";

const USER_A = "user_test";
const USER_B = "user_1";
const ORG = "org_test";

async function insertConn(
  database: TestDatabase,
  id: string,
  opts: {
    appId: string;
    access: "user" | "org";
    createdBy?: string;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await sql`
    INSERT INTO connections (
      id, organization_id, created_by, title, connection_type,
      connection_url, app_id, access, status, created_at, updated_at
    ) VALUES (
      ${id}, ${ORG}, ${opts.createdBy ?? USER_A}, 'test', 'HTTP',
      'https://example.com', ${opts.appId},
      ${opts.access}, 'active', ${now}, ${now}
    )
  `.execute(database.db);
}

/**
 * Build a minimal MeshContext shim sufficient for createVirtualClientFrom.
 * Only the fields the function actually touches are populated; everything
 * else is cast through so TypeScript stays happy without us reconstructing
 * the entire mesh runtime.
 */
function buildContext(
  database: TestDatabase,
  invokerUserId: string | null,
  connectionStorage: ConnectionStorage,
): MeshContext {
  return {
    auth: invokerUserId
      ? { user: { id: invokerUserId } }
      : { user: undefined, apiKey: undefined },
    db: database.db,
    tracer: trace.getTracer("slot-resolver-integration-test"),
    storage: {
      connections: connectionStorage,
    },
  } as unknown as MeshContext;
}

describe("slot resolution at virtual MCP client construction", () => {
  let database: TestDatabase;
  let connectionStorage: ConnectionStorage;
  let virtualMcps: VirtualMCPStorage;

  beforeEach(async () => {
    database = await createTestDatabase();
    await createTestSchema(database.db);
    await seedCommonTestFixtures(database.db);
    const vault = new CredentialVault(CredentialVault.generateKey());
    connectionStorage = new ConnectionStorage(database.db, vault);
    virtualMcps = new VirtualMCPStorage(database.db);
  });

  afterEach(async () => {
    await closeTestDatabase(database);
  });

  it("resolves slot to caller's user-private connection", async () => {
    // Caller has both an org-shared and a user-private connection of the
    // same app_id; the user-private one wins.
    await insertConn(database, "conn_shared", {
      appId: "mcp-github",
      access: "org",
    });
    await insertConn(database, "conn_private", {
      appId: "mcp-github",
      access: "user",
      createdBy: USER_A,
    });

    const agent = await virtualMcps.create(ORG, USER_A, {
      title: "agent with slot",
      status: "active",
      pinned: false,
      connections: [],
      slots: [
        {
          slot_app_id: "mcp-github",
          selected_tools: null,
          selected_resources: null,
          selected_prompts: null,
        },
      ],
    });

    const ctx = buildContext(database, USER_A, connectionStorage);
    const client = await createVirtualClientFrom(agent, ctx, "passthrough");

    // The PassthroughClient's view of children must include the resolved
    // private connection on BOTH the metadata array and the entity array.
    const titleMap = client.getConnectionTitleMap();
    expect(titleMap.has("conn_private")).toBe(true);
    expect(titleMap.has("conn_shared")).toBe(false);
  });

  it("falls back to org-shared when caller has no private connection", async () => {
    await insertConn(database, "conn_shared", {
      appId: "mcp-github",
      access: "org",
    });

    const agent = await virtualMcps.create(ORG, USER_A, {
      title: "agent with slot",
      status: "active",
      pinned: false,
      connections: [],
      slots: [
        {
          slot_app_id: "mcp-github",
          selected_tools: null,
          selected_resources: null,
          selected_prompts: null,
        },
      ],
    });

    // USER_B has no user-private mcp-github connection — must fall back
    // to the org-shared one.
    const ctx = buildContext(database, USER_B, connectionStorage);
    const client = await createVirtualClientFrom(agent, ctx, "passthrough");

    const titleMap = client.getConnectionTitleMap();
    expect(titleMap.has("conn_shared")).toBe(true);
  });

  it("throws SlotUnresolvedError when no matching connection exists", async () => {
    // Agent declares a slot for mcp-github but no such connection exists
    // in the org.
    const agent = await virtualMcps.create(ORG, USER_A, {
      title: "agent with unresolved slot",
      status: "active",
      pinned: false,
      connections: [],
      slots: [
        {
          slot_app_id: "mcp-github",
          selected_tools: null,
          selected_resources: null,
          selected_prompts: null,
        },
      ],
    });

    const ctx = buildContext(database, USER_A, connectionStorage);

    let caught: unknown;
    try {
      await createVirtualClientFrom(agent, ctx, "passthrough");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SlotUnresolvedError);
    expect((caught as SlotUnresolvedError).appId).toBe("mcp-github");
  });
});
