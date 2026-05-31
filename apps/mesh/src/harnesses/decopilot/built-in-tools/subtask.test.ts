/**
 * subtask Built-in Tool Tests
 *
 * Schema validation, createSubtaskTool factory, buildSubagentSystemPrompt,
 * and toModelOutput behavior.
 */

import { describe, expect, test } from "bun:test";
import {
  createSubtaskTool,
  SubtaskInputSchema,
  type SubtaskParams,
} from "./subtask";

const mockParams: SubtaskParams = {
  provider: { thinkingModel: {} as never } as never,
  organization: { id: "org_test" } as never,
  models: {
    connectionId: "conn_test",
    thinking: { id: "model_test", limits: {} },
  } as never,
};

const mockCtx = {
  storage: { virtualMcps: { findById: () => Promise.resolve(null) } },
} as never;

const mockWriter = {
  write: () => {},
  merge: () => {},
} as never;

/**
 * A minimal fake tracer whose startActiveSpan immediately invokes the
 * callback with a no-op span and returns its result.  The three-argument
 * overload (name, options, fn) is the one used by createVirtualClientFrom.
 */
const fakeTracer = {
  startActiveSpan: (
    _name: string,
    _opts: unknown,
    fn: (span: unknown) => unknown,
  ) => {
    const fakeSpan = {
      setStatus: () => {},
      recordException: () => {},
      end: () => {},
      setAttribute: () => {},
    };
    return fn(fakeSpan);
  },
} as never;

/**
 * A virtualMcp entity that is active and has one typed slot for "app-x".
 * No concrete connections so the slot block is the only path that matters.
 */
const virtualMcpWithSlot = {
  id: "vmcp_1",
  organization_id: "org_test",
  status: "active",
  title: "My Agent",
  connections: [],
  slots: [
    {
      slot_app_id: "app-x",
      selected_tools: null,
      selected_resources: null,
      selected_prompts: null,
    },
  ],
} as never;

/**
 * Context that returns virtualMcpWithSlot and has no authenticated user,
 * which causes createVirtualClientFrom to treat all slots as unresolved
 * (invokerUserId === null path) and throw SlotUnresolvedError without
 * requiring a real database.
 */
const mockCtxWithSlots = {
  auth: {},
  tracer: fakeTracer,
  storage: {
    virtualMcps: {
      findById: () => Promise.resolve(virtualMcpWithSlot),
    },
    connections: {
      findById: () => Promise.resolve(null),
    },
  },
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

  test("emits data-connect-required chunk and yields error when SlotUnresolvedError is thrown", async () => {
    const writeCalls: unknown[] = [];
    const spyWriter = {
      write: (chunk: unknown) => {
        writeCalls.push(chunk);
      },
      merge: () => {},
    } as never;

    const toolCallId = "tc_slot_test";
    const agentId = "vmcp_1";

    const subtaskTool = createSubtaskTool(
      spyWriter,
      mockParams,
      mockCtxWithSlots,
    );

    // Drive the async generator to completion.
    const yielded: unknown[] = [];
    const gen = subtaskTool.execute!(
      { prompt: "do something", agent_id: agentId },
      { toolCallId, abortSignal: new AbortController().signal } as never,
    ) as AsyncGenerator<unknown>;

    for await (const value of gen) {
      yielded.push(value);
    }

    // writer.write must have been called with the connect-required chunk.
    expect(writeCalls).toHaveLength(1);
    const chunk = writeCalls[0] as {
      type: string;
      id: string;
      data: { agentId: string; agentTitle: string; appIds: string[] };
    };
    expect(chunk.type).toBe("data-connect-required");
    expect(chunk.id).toBe(toolCallId);
    expect(chunk.data.agentId).toBe(agentId);
    expect(chunk.data.agentTitle).toBe("My Agent");
    expect(chunk.data.appIds).toEqual(["app-x"]);

    // The generator must have yielded exactly one value with the error text
    // and finishReason "stop", then terminated cleanly.
    expect(yielded).toHaveLength(1);
    const result = yielded[0] as {
      text: string;
      error: string;
      finishReason: string;
    };
    expect(result.text).toBe("");
    expect(result.error).toContain("connect");
    expect(result.error).toContain("app-x");
    expect(result.finishReason).toBe("stop");
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

describe("toModelOutput (new runAgentLoop-based contract)", () => {
  const tool = createSubtaskTool(mockWriter, mockParams, mockCtx);
  const toModelOutput = tool.toModelOutput!;

  const baseArgs = {
    toolCallId: "tc_test",
    input: { prompt: "test", agent_id: "vir_test" } as const,
  };

  test("returns text when output has text and no error", () => {
    const result = toModelOutput({
      ...baseArgs,
      output: {
        text: "**Result**: 12 unused connections.",
        error: undefined,
        finishReason: "stop",
      } as never,
    });
    expect(result).toEqual({
      type: "text",
      value: "**Result**: 12 unused connections.",
    });
  });

  test("returns error-text when output has an error", () => {
    const result = toModelOutput({
      ...baseArgs,
      output: {
        text: "I'll start by listing...",
        error: "AI_APICallError: prompt is too long",
        finishReason: "error",
      } as never,
    }) as { type: string; value: string };
    expect(result.type).toBe("error-text");
    expect(result.value).toContain("Subtask failed:");
    expect(result.value).toContain("prompt is too long");
  });

  test("error takes precedence over text", () => {
    const result = toModelOutput({
      ...baseArgs,
      output: {
        text: "Step 1 done.",
        error: "Context window exceeded",
        finishReason: "error",
      } as never,
    }) as { type: string; value: string };
    expect(result.type).toBe("error-text");
  });

  test("prefixes text with step-limit notice when finishReason is 'length'", () => {
    const result = toModelOutput({
      ...baseArgs,
      output: {
        text: "Partial report.",
        error: undefined,
        finishReason: "length",
      } as never,
    }) as { type: string; value: string };
    expect(result.type).toBe("text");
    expect(result.value).toContain("[Subtask hit step limit");
    expect(result.value).toContain("Partial report.");
  });

  test("returns fallback when output is undefined", () => {
    const result = toModelOutput({
      ...baseArgs,
      output: undefined as never,
    });
    expect(result).toEqual({
      type: "text",
      value: "Subtask completed (no output).",
    });
  });

  test("returns fallback when output is null", () => {
    const result = toModelOutput({
      ...baseArgs,
      output: null as never,
    });
    expect(result).toEqual({
      type: "text",
      value: "Subtask completed (no output).",
    });
  });

  test("returns fallback when output has empty text and no error", () => {
    const result = toModelOutput({
      ...baseArgs,
      output: { text: "", error: undefined, finishReason: "stop" } as never,
    });
    expect(result).toEqual({
      type: "text",
      value: "Subtask completed (no output).",
    });
  });

  test("returns fallback when output has only whitespace text", () => {
    const result = toModelOutput({
      ...baseArgs,
      output: {
        text: "   \n  ",
        error: undefined,
        finishReason: "stop",
      } as never,
    });
    expect(result).toEqual({
      type: "text",
      value: "Subtask completed (no output).",
    });
  });

  test("returns step-limit notice when finishReason is 'length' and text is empty", () => {
    const result = toModelOutput({
      ...baseArgs,
      output: {
        text: "",
        error: undefined,
        finishReason: "length",
      } as never,
    }) as { type: string; value: string };
    expect(result.type).toBe("text");
    expect(result.value).toContain("step limit");
    expect(result.value).toContain("ran out of steps");
  });
});
