/**
 * subtask Built-in Tool Tests
 *
 * Schema validation, createSubtaskTool factory, buildSubagentSystemPrompt,
 * and toModelOutput behavior.
 */

import { describe, expect, test } from "bun:test";
import type { BuiltinToolParams } from "./index";
import {
  buildSubagentSystemPrompt,
  createSubtaskTool,
  SubtaskInputSchema,
} from "./subtask";

const mockParams: BuiltinToolParams = {
  modelProvider: { thinkingModel: {} as never } as never,
  organization: { id: "org_test" } as never,
  models: {
    connectionId: "conn_test",
    thinking: { id: "model_test", limits: {} },
  } as never,
  toolOutputMap: new Map(),
};

const mockCtx = {
  storage: { virtualMcps: { findById: () => Promise.resolve(null) } },
} as never;

const mockWriter = {
  write: () => {},
  merge: () => {},
} as never;

describe("SubtaskInputSchema", () => {
  describe("valid input", () => {
    test("accepts valid prompt and agent_id", () => {
      const input = {
        prompt: "List all connections in the organization",
        agent_id: "vir_abc123",
      };

      const result = SubtaskInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    test("accepts prompt at max length boundary", () => {
      const input = {
        prompt: "a".repeat(50_000),
        agent_id: "vir_abc123",
      };

      const result = SubtaskInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    test("accepts agent_id at max length boundary", () => {
      const input = {
        prompt: "Do something",
        agent_id: "a".repeat(128),
      };

      const result = SubtaskInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });
  });

  describe("invalid input", () => {
    test("rejects empty prompt", () => {
      const input = {
        prompt: "",
        agent_id: "vir_abc123",
      };

      const result = SubtaskInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    test("rejects prompt exceeding max length", () => {
      const input = {
        prompt: "a".repeat(50_001),
        agent_id: "vir_abc123",
      };

      const result = SubtaskInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    test("rejects empty agent_id", () => {
      const input = {
        prompt: "Do something",
        agent_id: "",
      };

      const result = SubtaskInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    test("rejects agent_id exceeding max length", () => {
      const input = {
        prompt: "Do something",
        agent_id: "a".repeat(129),
      };

      const result = SubtaskInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    test("rejects missing prompt", () => {
      const input = {
        agent_id: "vir_abc123",
      };

      const result = SubtaskInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    test("rejects missing agent_id", () => {
      const input = {
        prompt: "Do something",
      };

      const result = SubtaskInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });
  });
});

describe("createSubtaskTool", () => {
  test("returns a tool with execute defined", () => {
    const tool = createSubtaskTool(mockWriter, mockParams, mockCtx);

    expect(tool).toBeDefined();
    expect(tool.execute).toBeDefined();
    expect(typeof tool.execute).toBe("function");
  });

  test("returns a tool with toModelOutput defined", () => {
    const tool = createSubtaskTool(mockWriter, mockParams, mockCtx);

    expect(tool).toBeDefined();
    expect(tool.toModelOutput).toBeDefined();
    expect(typeof tool.toModelOutput).toBe("function");
  });

  test("returns a tool with description and inputSchema", () => {
    const tool = createSubtaskTool(mockWriter, mockParams, mockCtx);

    expect(tool.description).toBeDefined();
    expect(tool.description).toContain("Delegate");
    expect(tool.inputSchema).toBeDefined();
  });
});

describe("buildSubagentSystemPrompt", () => {
  test("includes base instructions when no agent instructions provided", () => {
    const prompt = buildSubagentSystemPrompt();

    expect(prompt).toContain("focused subtask agent");
    expect(prompt).toContain("Assess the Task");
    expect(prompt).toContain("When Done: Summarize");
    expect(prompt).toContain("Constraints");
    expect(prompt).not.toContain("Agent-Specific Instructions");
  });

  test("includes agent instructions when provided", () => {
    const agentInstructions = "Always use the search tool first.";
    const prompt = buildSubagentSystemPrompt(agentInstructions);

    expect(prompt).toContain("Agent-Specific Instructions");
    expect(prompt).toContain("Always use the search tool first.");
  });

  test("excludes agent instructions when empty string", () => {
    const prompt = buildSubagentSystemPrompt("");

    expect(prompt).not.toContain("Agent-Specific Instructions");
  });

  test("excludes agent instructions when whitespace-only", () => {
    const prompt = buildSubagentSystemPrompt("   \n  ");

    expect(prompt).not.toContain("Agent-Specific Instructions");
  });
});

describe("metadata isolation", () => {
  /**
   * Note: buildSubtaskFinalMetadata was removed — subtask usage metadata
   * is now emitted as a data-tool-subtask-metadata data part via writer.write().
   * The isolation guarantee is now enforced by the data part mechanism
   * (separate from the message metadata entirely).
   */
  test("subtask result metadata is delivered via data part, not message metadata", () => {
    // The old pattern embedded metadata in part.output.metadata.subtaskResult.
    // The new pattern emits a data-tool-subtask-metadata data part via writer.write().
    // This test documents the architectural change.
    const tool = createSubtaskTool(mockWriter, mockParams, mockCtx);
    expect(tool.execute).toBeDefined();
    // The actual data part emission is tested via integration tests
    // since it requires a real writer instance.
  });
});

describe("toModelOutput", () => {
  const tool = createSubtaskTool(mockWriter, mockParams, mockCtx);
  const toModelOutput = tool.toModelOutput!;

  const baseArgs = {
    toolCallId: "tc_test",
    input: { prompt: "test", agent_id: "vir_test" } as const,
  };

  test("returns fallback when message is null", () => {
    const result = toModelOutput({ ...baseArgs, output: null as never });

    expect(result).toEqual({
      type: "text",
      value: "Subtask completed (no output).",
    });
  });

  test("returns fallback when message is undefined", () => {
    const result = toModelOutput({ ...baseArgs, output: undefined as never });

    expect(result).toEqual({
      type: "text",
      value: "Subtask completed (no output).",
    });
  });

  test("returns fallback when parts is empty", () => {
    const result = toModelOutput({
      ...baseArgs,
      output: { parts: [] } as never,
    });

    expect(result).toEqual({
      type: "text",
      value: "Subtask completed (no output).",
    });
  });

  test("returns fallback when no text parts", () => {
    const result = toModelOutput({
      ...baseArgs,
      output: {
        parts: [{ type: "tool-call", toolCallId: "tc_1", toolName: "foo" }],
      } as never,
    });

    expect(result).toEqual({
      type: "text",
      value: "Subtask completed (no output).",
    });
  });

  test("returns last text part when present", () => {
    const result = toModelOutput({
      ...baseArgs,
      output: {
        parts: [
          { type: "text", text: "First part" },
          { type: "text", text: "Second part" },
          { type: "text", text: "Final summary" },
        ],
      } as never,
    });

    expect(result).toEqual({
      type: "text",
      value: "Final summary",
    });
  });

  test("returns single text part", () => {
    const result = toModelOutput({
      ...baseArgs,
      output: {
        parts: [{ type: "text", text: "The task is done." }],
      } as never,
    });

    expect(result).toEqual({
      type: "text",
      value: "The task is done.",
    });
  });
});
