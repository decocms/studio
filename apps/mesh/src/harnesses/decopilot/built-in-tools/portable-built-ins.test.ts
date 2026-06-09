import { describe, expect, it } from "bun:test";
import { buildPortableBuiltInTools } from "./portable-built-ins";

const writer = {
  write: () => {},
  merge: async () => {},
  onError: () => {},
} as never;

const passthroughClient = {
  readResource: async () => ({ contents: [] }),
  getPrompt: async () => ({ messages: [] }),
  listTools: async () => ({ tools: [] }),
  callTool: async () => ({ content: [] }),
  listResources: async () => ({ resources: [] }),
  listPrompts: async () => ({ prompts: [] }),
} as never;

describe("buildPortableBuiltInTools", () => {
  it("builds the common Decopilot tool vocabulary without cluster context", () => {
    const tools = buildPortableBuiltInTools({
      writer,
      toolOutputMap: new Map(),
      passthroughClient,
      toolApprovalLevel: "auto",
      isPlanMode: false,
    });

    expect(Object.keys(tools).sort()).toEqual([
      "propose_plan",
      "read_prompt",
      "read_resource",
      "read_tool_output",
      "sandbox",
      "todo_write",
      "user_ask",
    ]);
  });

  it("registers the desktop subtask relay only when all relay inputs exist", () => {
    const tools = buildPortableBuiltInTools({
      writer,
      toolOutputMap: new Map(),
      passthroughClient,
      toolApprovalLevel: "auto",
      isPlanMode: false,
      subtaskRelay: {
        mcpClient: passthroughClient,
        models: {
          credentialId: "cred-1",
          thinking: { id: "gpt-4.1" },
        },
        selfAgentId: "agent-1",
      },
    });

    expect("subtask" in tools).toBe(true);
  });
});
