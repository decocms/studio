import { describe, expect, test } from "bun:test";
import {
  assembleAgentTools,
  EXCLUDED_FOR_SUBAGENT,
} from "./assemble-agent-tools";

const mockMcpClient = {
  listTools: async () => ({ tools: [] }),
  getInstructions: () => "",
} as never;

const mockCtx = {} as never;
const mockWriter = { write: () => {}, merge: () => {} } as never;
const mockSubtaskParams = {
  provider: {} as never,
  organization: { id: "org_test" } as never,
  models: {} as never,
};

describe("assembleAgentTools", () => {
  test("kind: 'agent' includes subtask, user_ask, propose_plan in built-ins", async () => {
    const { tools } = await assembleAgentTools({
      kind: "agent",
      ctx: mockCtx,
      mcpClient: mockMcpClient,
      writer: mockWriter,
      planMode: false,
      toolApprovalLevel: "high" as never,
      subtaskParams: mockSubtaskParams,
    });
    for (const name of ["subtask", "user_ask", "propose_plan"]) {
      expect(tools).toHaveProperty(name);
    }
  });

  test("kind: 'subagent' EXCLUDES subtask, user_ask, propose_plan", async () => {
    const { tools } = await assembleAgentTools({
      kind: "subagent",
      ctx: mockCtx,
      mcpClient: mockMcpClient,
      writer: mockWriter,
      planMode: false,
      toolApprovalLevel: "auto",
      subtaskParams: mockSubtaskParams,
    });
    for (const name of ["subtask", "user_ask", "propose_plan"]) {
      expect(tools).not.toHaveProperty(name);
    }
  });

  test("kind: 'subagent' includes the always-on built-ins", async () => {
    const { tools } = await assembleAgentTools({
      kind: "subagent",
      ctx: mockCtx,
      mcpClient: mockMcpClient,
      writer: mockWriter,
      planMode: false,
      toolApprovalLevel: "auto",
      subtaskParams: mockSubtaskParams,
    });
    for (const name of ["read_tool_output", "todo_write"]) {
      expect(tools).toHaveProperty(name);
    }
  });

  test("EXCLUDED_FOR_SUBAGENT is the canonical exclusion list", () => {
    expect(EXCLUDED_FOR_SUBAGENT).toEqual([
      "subtask",
      "user_ask",
      "propose_plan",
    ]);
  });

  test("always returns toolOutputMap for read_tool_output to share", async () => {
    const result = await assembleAgentTools({
      kind: "subagent",
      ctx: mockCtx,
      mcpClient: mockMcpClient,
      writer: mockWriter,
      planMode: false,
      toolApprovalLevel: "auto",
      subtaskParams: mockSubtaskParams,
    });
    expect(result.toolOutputMap).toBeInstanceOf(Map);
  });
});
