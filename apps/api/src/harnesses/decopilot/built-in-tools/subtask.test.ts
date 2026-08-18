/**
 * subtask Built-in Tool Tests
 *
 * Schema validation, createSubtaskTool factory, buildSubagentSystemPrompt,
 * and toModelOutput behavior.
 */

import { describe, expect, test } from "bun:test";
import {
  createSubtaskTool,
  isTransientStreamError,
  settled,
  resolveSubtaskCodingWorkspace,
  SubtaskInputSchema,
  type SubtaskParams,
} from "./subtask";

describe("isTransientStreamError", () => {
  test("resumes a broken transport", () => {
    for (const message of [
      // The prod failure this was written for (thread c12c86aa, 2026-07-31).
      "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
      "read ECONNRESET",
      "write EPIPE",
      "connect ETIMEDOUT 1.2.3.4:443",
      "fetch failed",
      "terminated",
      "Provider returned error 502",
      "upstream timed out",
      "Model is overloaded, please try again",
    ]) {
      expect(isTransientStreamError(message)).toBe(true);
    }
  });

  test("does not resume a request the provider rejected on its merits", () => {
    for (const message of [
      "This endpoint's maximum context length is 200000 tokens",
      "Invalid API key provided",
      "No endpoints found that support tool use",
      "Run aborted before completion.",
      "messages: at least one message is required",
    ]) {
      expect(isTransientStreamError(message)).toBe(false);
    }
  });
});

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

describe("settled", () => {
  test("passes a resolved value through", async () => {
    expect(await settled(Promise.resolve("stop"), "error")).toBe("stop");
  });

  test("swallows the AI SDK's NoOutputGeneratedError rejection", async () => {
    // streamText rejects finishReason/steps/usage when no step ever finished.
    // Throwing that out of the subtask generator replaced the real cause with
    // the SDK's placeholder text (prod thread 38147122, 2026-08-16).
    const rejected = Promise.reject(
      new Error("No output generated. Check the stream for errors."),
    );
    expect(await settled(rejected, "error")).toBe("error");
  });
});

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

    test("accepts a concrete MCP connection id as agent_id", () => {
      const result = SubtaskInputSchema.safeParse({
        prompt: "Inspect the latest orders",
        agent_id: "conn_orders",
      });

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

    test("accepts missing agent_id (clone-self: omit agent_id)", () => {
      const input = {
        prompt: "Do something",
      };

      const result = SubtaskInputSchema.safeParse(input);
      expect(result.success).toBe(true);
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
    expect(tool.description).toContain("subagent");
    expect(tool.inputSchema).toBeDefined();
  });
});

describe("resolveSubtaskCodingWorkspace", () => {
  test("uses target repo facts while inheriting branch and cwd from parent workspace", () => {
    const result = resolveSubtaskCodingWorkspace(
      {
        repo: {
          owner: "deco",
          name: "site",
          connectionId: "conn-1",
        } as never,
      },
      {
        repo: {
          owner: "deco",
          name: "other",
          connectedGithub: true,
        },
        branch: "main",
        cwd: "/repo",
        workspaceKind: "github",
      },
    );

    expect(result).toEqual({
      repo: {
        owner: "deco",
        name: "site",
        connectedGithub: true,
      },
      branch: "main",
      cwd: "/repo",
      workspaceKind: "github",
    });
  });

  test("marks target public clone repo as not connected to GitHub", () => {
    const result = resolveSubtaskCodingWorkspace(
      {
        repo: {
          owner: "deco",
          name: "public-site",
        },
      },
      {
        branch: "main",
        cwd: "/repo",
        workspaceKind: "github",
      },
    );

    expect(result).toEqual({
      repo: {
        owner: "deco",
        name: "public-site",
        connectedGithub: false,
      },
      branch: "main",
      cwd: "/repo",
      workspaceKind: "github",
    });
  });

  test("passes parent workspace through for self-clone targets with no repo", () => {
    const parentWorkspace = {
      cwd: "/repo",
      workspaceKind: "local" as const,
    };

    const result = resolveSubtaskCodingWorkspace(
      {
        repo: undefined,
      },
      parentWorkspace,
      true,
    );

    expect(result).toBe(parentWorkspace);
  });

  test("clears parent workspace for cross-agent targets with no repo", () => {
    const parentWorkspace = {
      cwd: "/repo",
      workspaceKind: "local" as const,
    };

    const result = resolveSubtaskCodingWorkspace(
      {
        repo: undefined,
      },
      parentWorkspace,
      false,
    );

    expect(result).toBeUndefined();
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

  test("error-text carries the partial result instead of discarding it", () => {
    const result = toModelOutput({
      ...baseArgs,
      output: {
        text: "Step 1 done.",
        error: "Context window exceeded",
        finishReason: "error",
      } as never,
    }) as { type: string; value: string };
    expect(result.type).toBe("error-text");
    expect(result.value).toContain("Context window exceeded");
    // Was previously dropped, which made the parent redo already-applied work.
    expect(result.value).toContain("Step 1 done.");
  });

  test("error-text omits the partial section when there is no partial text", () => {
    const result = toModelOutput({
      ...baseArgs,
      output: {
        text: "",
        error: "Context window exceeded",
        finishReason: "error",
      } as never,
    }) as { type: string; value: string };
    expect(result.value).toBe("Subtask failed: Context window exceeded");
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
