import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TaskBoardItemSchema } from "./schema";
import { z } from "zod";

/**
 * Regression: `TASK_BOARD_ITEM_CREATE`/`LIST`/`UPDATE` etc. failed at runtime
 * with `-32602: Structured content does not match the tool's output schema`
 * on every call, because `TaskBoardItemSchema` — a closed Zod object, which
 * advertises JSON Schema `additionalProperties: false` — never modeled
 * `retryAttempts`, even though every real `TaskBoardItem` the storage layer
 * returns (see `storage/types.ts` and `itemFromDbRow`) carries that field.
 *
 * The handler itself returns the field fine (Zod strips nothing since the
 * handler doesn't re-validate its own output), but any MCP client that lists
 * tools first (caching the advertised output JSON Schema) and then
 * re-validates `structuredContent` with Ajv — e.g. the studio proxy via
 * `client.callTool` — rejected every response the moment `retryAttempts` was
 * present, i.e. always.
 *
 * This test reproduces that proxy-side validation with a real in-memory MCP
 * server <-> client round-trip, the same way `../registry/schema.test.ts`
 * covers the equivalent registry bug.
 */
describe("TaskBoardItemSchema – proxy round-trip validation", () => {
  const outputSchema = z.object({ item: TaskBoardItemSchema });

  const baseItem = {
    id: "board_123",
    organizationId: "org_1",
    title: "Fix the thing",
    description: null,
    status: "todo" as const,
    priority: "high" as const,
    assigneeId: null,
    assignedBy: null,
    repo: null,
    dueDate: null,
    sortOrder: 0,
    retryAttempts: 0,
    threads: [],
    tags: [],
    createdBy: "user_1",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedBy: "user_1",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };

  async function roundTrip(result: unknown) {
    const server = new McpServer({ name: "test-task-board", version: "0.0.0" });
    server.registerTool(
      "TASK_BOARD_ITEM_CREATE",
      { description: "create", outputSchema },
      async () => ({
        structuredContent: result as Record<string, unknown>,
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      }),
    );

    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      // The studio proxy lists tools (caching each tool's advertised output
      // schema), then calls the tool. The SDK client only validates output
      // for tools whose schema was cached via listTools().
      await client.listTools();
      return await client.callTool({
        name: "TASK_BOARD_ITEM_CREATE",
        arguments: {},
      });
    } finally {
      await client.close();
      await server.close();
    }
  }

  it("accepts an item with retryAttempts: 0 (the common case)", async () => {
    const result = await roundTrip({ item: baseItem });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { item: { id: string } }).item.id).toBe(
      "board_123",
    );
  });

  it("accepts an item with a non-zero retryAttempts (previously rejected)", async () => {
    const result = await roundTrip({
      item: { ...baseItem, retryAttempts: 2 },
    });
    expect(result.isError).toBeFalsy();
    expect(
      (result.structuredContent as { item: { retryAttempts: number } }).item
        .retryAttempts,
    ).toBe(2);
  });

  // Same bug class, a different field: threads always carry lastActiveAt.
  it("accepts a linked thread with lastActiveAt (previously rejected)", async () => {
    const result = await roundTrip({
      item: {
        ...baseItem,
        threads: [
          {
            threadId: "thread_1",
            virtualMcpId: null,
            status: "in_progress",
            title: "Fix the thing",
            lastMessage: null,
            hasPreview: false,
            failureKind: null,
            hasMessages: true,
            costUsd: null,
            costProvider: null,
            createdAt: "2024-01-01T00:00:00.000Z",
            lastActiveAt: "2024-01-01T00:05:00.000Z",
          },
        ],
      },
    });
    expect(result.isError).toBeFalsy();
    expect(
      (
        result.structuredContent as {
          item: { threads: { lastActiveAt: string }[] };
        }
      ).item.threads[0]?.lastActiveAt,
    ).toBe("2024-01-01T00:05:00.000Z");
  });
});
