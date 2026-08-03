/**
 * local-subtask Built-in Tool Tests
 *
 * Schema validation, createLocalSubtaskTool factory (data-chunk emission +
 * onChildUsage roll-up + self-vs-cross-agent target resolution), and the
 * toModelOutput error/step-limit/text formatting (copied verbatim from the
 * cluster subtask.ts — same expectations).
 */

import { describe, expect, test } from "bun:test";
import {
  createLocalSubtaskTool,
  SubtaskInputSchema,
  type LocalSubtaskParams,
} from "./local-subtask";
import type { SubtaskRunResult } from "../run-core";
import type { ModelsConfig } from "../../types";

const zeroUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

const models: ModelsConfig = {
  thinking: { id: "claude-test", credentialId: "cred_1" },
};

function makeTool(overrides: Partial<LocalSubtaskParams> = {}) {
  const writes: Array<{ type: string; data: unknown }> = [];
  const childUsages: SubtaskRunResult["usage"][] = [];
  const subtaskCalls: Array<{
    prompt: string;
    target: string | undefined;
  }> = [];
  const writer = {
    write: (chunk: { type: string; data: unknown }) => writes.push(chunk),
    merge: () => {},
    onError: () => {},
  } as never;

  const runSubtask: LocalSubtaskParams["runSubtask"] = async (
    prompt,
    target,
  ) => {
    subtaskCalls.push({ prompt, target });
    return {
      text: "child report",
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    };
  };

  const tool = createLocalSubtaskTool({
    writer,
    selfAgentId: "vir_self",
    models,
    runSubtask,
    onChildUsage: (usage) => childUsages.push(usage),
    ...overrides,
  });

  return { tool, writes, childUsages, subtaskCalls };
}

describe("SubtaskInputSchema", () => {
  test("accepts prompt + agent_id", () => {
    expect(
      SubtaskInputSchema.safeParse({ prompt: "go", agent_id: "vir_x" }).success,
    ).toBe(true);
  });

  test("accepts a concrete MCP connection id", () => {
    expect(
      SubtaskInputSchema.safeParse({
        prompt: "go",
        agent_id: "conn_orders",
      }).success,
    ).toBe(true);
  });
  test("accepts missing agent_id (self-clone)", () => {
    expect(SubtaskInputSchema.safeParse({ prompt: "go" }).success).toBe(true);
  });
  test("rejects empty prompt", () => {
    expect(SubtaskInputSchema.safeParse({ prompt: "" }).success).toBe(false);
  });
  test("rejects prompt over 50k", () => {
    expect(
      SubtaskInputSchema.safeParse({ prompt: "a".repeat(50_001) }).success,
    ).toBe(false);
  });
  test("rejects agent_id over 128", () => {
    expect(
      SubtaskInputSchema.safeParse({
        prompt: "go",
        agent_id: "a".repeat(129),
      }).success,
    ).toBe(false);
  });
});

describe("createLocalSubtaskTool execute", () => {
  const exec = (
    tool: ReturnType<typeof createLocalSubtaskTool>,
    input: { prompt: string; agent_id?: string },
  ) =>
    (
      tool.execute as (
        i: { prompt: string; agent_id?: string },
        o: { abortSignal?: AbortSignal; toolCallId: string },
      ) => Promise<SubtaskRunResult>
    )(input, { toolCallId: "tc_1" });

  test("emits both data chunks and calls onChildUsage", async () => {
    const { tool, writes, childUsages } = makeTool();
    const result = await exec(tool, { prompt: "research X" });

    expect(result.text).toBe("child report");
    expect(childUsages).toEqual([
      { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    ]);

    const types = writes.map((w) => w.type);
    expect(types).toContain("data-tool-metadata");
    expect(types).toContain("data-tool-subtask-metadata");

    const meta = writes.find((w) => w.type === "data-tool-subtask-metadata")!
      .data as { usage: unknown; agent: string; models: ModelsConfig };
    expect(meta.agent).toBe("vir_self");
    expect(meta.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
    // Parity with cluster subtask.ts: the chunk carries `models` so the
    // ToolSubtaskMetadata `models` field (declared required) is honest.
    expect(meta.models).toEqual(models);
  });

  test("self-clone: omitted agent_id resolves target undefined", async () => {
    const { tool, subtaskCalls } = makeTool();
    await exec(tool, { prompt: "go" });
    expect(subtaskCalls).toEqual([{ prompt: "go", target: undefined }]);
  });

  test("self-clone: own agent_id resolves target undefined", async () => {
    const { tool, subtaskCalls } = makeTool();
    await exec(tool, { prompt: "go", agent_id: "vir_self" });
    expect(subtaskCalls[0]?.target).toBeUndefined();
  });

  test("cross-agent: different agent_id flows through as target", async () => {
    const { tool, subtaskCalls, writes } = makeTool();
    await exec(tool, { prompt: "go", agent_id: "vir_other" });
    expect(subtaskCalls[0]?.target).toBe("vir_other");
    const meta = writes.find((w) => w.type === "data-tool-subtask-metadata")!
      .data as { agent: string };
    expect(meta.agent).toBe("vir_other");
  });

  test("onChildUsage is optional", async () => {
    const { tool } = makeTool({ onChildUsage: undefined });
    const result = await exec(tool, { prompt: "go" });
    expect(result.text).toBe("child report");
  });
});

describe("createLocalSubtaskTool factory shape", () => {
  test("exposes description, inputSchema, execute, toModelOutput", () => {
    const { tool } = makeTool();
    expect(tool.description).toContain("subagent");
    expect(tool.inputSchema).toBeDefined();
    expect(typeof tool.execute).toBe("function");
    expect(typeof tool.toModelOutput).toBe("function");
  });
});

describe("toModelOutput", () => {
  const { tool } = makeTool();
  const toModelOutput = tool.toModelOutput!;
  const base = { toolCallId: "tc", input: { prompt: "p" } as const };

  test("returns text when output has text and no error", () => {
    expect(
      toModelOutput({
        ...base,
        output: {
          text: "**Result**: ok.",
          finishReason: "stop",
          usage: zeroUsage,
        } as never,
      }),
    ).toEqual({ type: "text", value: "**Result**: ok." });
  });

  test("returns error-text when output has an error", () => {
    const r = toModelOutput({
      ...base,
      output: {
        text: "partial",
        error: "AI_APICallError: prompt is too long",
        finishReason: "error",
        usage: zeroUsage,
      } as never,
    }) as { type: string; value: string };
    expect(r.type).toBe("error-text");
    expect(r.value).toContain("Subtask failed:");
    expect(r.value).toContain("prompt is too long");
  });

  test("error takes precedence over text", () => {
    const r = toModelOutput({
      ...base,
      output: {
        text: "step done",
        error: "boom",
        finishReason: "error",
        usage: zeroUsage,
      } as never,
    }) as { type: string };
    expect(r.type).toBe("error-text");
  });

  test("prefixes text with step-limit notice when finishReason length", () => {
    const r = toModelOutput({
      ...base,
      output: {
        text: "partial report",
        finishReason: "length",
        usage: zeroUsage,
      } as never,
    }) as { type: string; value: string };
    expect(r.type).toBe("text");
    expect(r.value).toContain("[Subtask hit step limit");
    expect(r.value).toContain("partial report");
  });

  test("fallback when output undefined", () => {
    expect(toModelOutput({ ...base, output: undefined as never })).toEqual({
      type: "text",
      value: "Subtask completed (no output).",
    });
  });

  test("fallback when text empty/whitespace and no error", () => {
    expect(
      toModelOutput({
        ...base,
        output: {
          text: "  \n ",
          finishReason: "stop",
          usage: zeroUsage,
        } as never,
      }),
    ).toEqual({ type: "text", value: "Subtask completed (no output)." });
  });

  test("step-limit notice when finishReason length and text empty", () => {
    const r = toModelOutput({
      ...base,
      output: { text: "", finishReason: "length", usage: zeroUsage } as never,
    }) as { type: string; value: string };
    expect(r.type).toBe("text");
    expect(r.value).toContain("step limit");
    expect(r.value).toContain("ran out of steps");
  });
});
