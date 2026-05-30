/**
 * Tests for Built-in Tools Registration
 *
 * Verifies getBuiltInTools() returns correct ToolSet structure
 */

import { describe, expect, test } from "bun:test";
import { getBuiltInTools, type BuiltinToolParams } from "./index";

const mockProvider = { thinkingModel: {} as never } as never;
const mockParams: BuiltinToolParams = {
  provider: mockProvider,
  imageProvider: mockProvider,
  deepResearchProvider: mockProvider,
  organization: { id: "org_test" } as never,
  models: {
    connectionId: "conn_test",
    thinking: { id: "model_test" },
  } as never,
  toolOutputMap: new Map(),
  pendingImages: [],
  taskId: "task_test",
  passthroughClient: {
    listTools: () => Promise.resolve({ tools: [] }),
    callTool: () => Promise.resolve({ content: [] }),
  } as never,
  htmlPageBuffer: {} as never,
};

const mockCtx = {
  storage: { virtualMcps: { findById: () => Promise.resolve(null) } },
} as never;

const mockWriter = {
  write: () => {},
  merge: () => {},
} as never;

function getTools() {
  return getBuiltInTools(mockWriter, mockParams, mockCtx);
}

describe("getBuiltInTools", () => {
  test("returns ToolSet with user_ask tool", async () => {
    const tools = await getTools();

    expect(tools).toBeDefined();
    expect(tools.user_ask).toBeDefined();
  });

  test("returns ToolSet with subtask tool", async () => {
    const tools = await getTools();

    expect(tools).toBeDefined();
    expect(tools.subtask).toBeDefined();
  });

  test("user_ask tool has correct description", async () => {
    const tools = await getTools();

    expect(tools.user_ask?.description).toContain(
      "Ask the user instead of guessing when requirements are ambiguous",
    );
  });

  test("user_ask tool has no execute function", async () => {
    const tools = await getTools();

    // Client-side tools should not have execute function defined
    // (execute is optional in AI SDK tool type)
    expect(tools.user_ask?.execute).toBeUndefined();
  });

  test("subtask tool has execute function", async () => {
    const tools = await getTools();

    expect(tools.subtask?.execute).toBeDefined();
  });

  test("returns object matching ToolSet type structure", async () => {
    const tools = await getTools();

    // ToolSet is Record<string, CoreTool>
    // Each tool should be an object with description, inputSchema, etc.
    expect(typeof tools).toBe("object");
    expect(Object.keys(tools)).toContain("user_ask");
    expect(Object.keys(tools)).toContain("subtask");

    const userAskTool = tools.user_ask;
    expect(userAskTool).toHaveProperty("description");
    expect(typeof userAskTool?.description).toBe("string");
  });

  test("does not include open_in_agent tool", () => {
    const tools = getTools();

    expect(Object.keys(tools)).not.toContain("open_in_agent");
  });

  test("returns ToolSet with todo_write tool", async () => {
    const tools = await getTools();
    expect((tools as Record<string, unknown>).todo_write).toBeDefined();
  });

  test("todo_write tool has correct description", async () => {
    const tools = await getTools();
    const t = (tools as Record<string, { description: string }>).todo_write!;
    expect(t.description).toContain("Plan and track multi-step work");
  });

  test("todo_write tool has execute function (server-side)", async () => {
    const tools = await getTools();
    const t = (tools as Record<string, { execute?: unknown }>).todo_write!;
    expect(typeof t.execute).toBe("function");
  });

  test("todo_write is registered unconditionally (no provider needed)", async () => {
    // Re-run with provider: null (Claude Code branch); todo_write should still appear
    const tools = await getBuiltInTools(
      mockWriter,
      { ...mockParams, provider: null as never },
      mockCtx,
    );
    expect((tools as Record<string, unknown>).todo_write).toBeDefined();
  });
});
