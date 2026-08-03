/**
 * spawnSubtask + core subtask-policy tests (Task 17).
 *
 * Drives the REAL `runDecopilotCore` via a synthetic `toolRuntime` whose
 * `runEngine` returns a fake `AssembledEngineHandle`. The fake engine's
 * `result.toUIMessageStream()` yields a controlled chunk sequence, so these
 * tests exercise the actual chunk-consumption, depth-1 tool-strip, step-budget
 * forwarding, signal-chaining, and usage roll-up paths — not a re-implementation.
 */

import { describe, expect, test } from "bun:test";
import type { ToolSet, UIMessageChunk } from "ai";
import {
  runDecopilotCore,
  spawnSubtask,
  SUBTASK_MAX_CONCURRENT,
  type RunDecopilotCoreDeps,
} from "./run-core";
import type {
  AssembledEngineHandle,
  HarnessAssembledTools,
  RunEngineArgs,
} from "./engine";
import { SUBAGENT_STEP_LIMIT } from "./prompt-constants";

// ── Fakes ────────────────────────────────────────────────────────────

function fakeSpan() {
  return {
    setAttribute: () => {},
    setStatus: () => {},
    recordException: () => {},
    end: () => {},
  } as never;
}

/** A fake StreamTextResult whose toUIMessageStream yields `chunks`. The
 *  `messageMetadata` callback run-stream supplies is applied to each chunk so
 *  `finish`/`finish-step` chunks pick up the accumulator-built usage. */
function fakeResult(
  chunks: UIMessageChunk[],
  totalUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  },
) {
  return {
    finishReason: Promise.resolve("stop"),
    totalUsage: Promise.resolve(totalUsage),
    usage: Promise.resolve(totalUsage),
    request: Promise.resolve({}),
    response: Promise.resolve({ id: "r", messages: [] }),
    steps: Promise.resolve([]),
    toUIMessageStream: (opts?: {
      messageMetadata?: (a: { part: UIMessageChunk }) => unknown;
    }) => ({
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          const md = opts?.messageMetadata?.({ part: chunk });
          if (md && (chunk.type === "finish" || chunk.type === "finish-step")) {
            yield { ...chunk, messageMetadata: md } as UIMessageChunk;
          } else {
            yield chunk;
          }
        }
      },
    }),
  } as never;
}

/** Records the args runEngine was called with (for step-budget / depth-1
 *  assertions) and returns a handle producing `chunks`. */
function makeToolRuntime(opts: {
  chunks: UIMessageChunk[];
  totalUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  tools?: ToolSet;
  captured?: { args?: RunEngineArgs };
  bundleRef?: { bundle?: HarnessAssembledTools };
}) {
  const tools: ToolSet = opts.tools ?? ({} as ToolSet);
  const bundle: HarnessAssembledTools = {
    tools,
    passthroughTools: {} as ToolSet,
    builtInTools: tools,
    connectionsBlockTools: [],
    toolAnnotations: new Map(),
    connectionTitleMap: new Map(),
    serverInstructions: undefined,
    passthroughClient: {
      listTools: async () => ({ tools: [] }),
      listPrompts: async () => ({ prompts: [] }),
      getInstructions: () => "",
    } as never,
    toolOutputMap: new Map(),
    writer: { write: () => {}, merge: () => {} } as never,
    pendingImages: [],
    close: async () => {},
  };
  if (opts.bundleRef) opts.bundleRef.bundle = bundle;
  return {
    buildEnvironmentTools: async () => bundle,
    runEngine: async (args: RunEngineArgs): Promise<AssembledEngineHandle> => {
      if (opts.captured) opts.captured.args = args;
      return {
        result: fakeResult(opts.chunks, opts.totalUsage),
        error: Promise.resolve(undefined),
        span: fakeSpan(),
        assembledSystemMessages: [],
      };
    },
  };
}

const baseInput = {
  threadId: "t1",
  userMessage: {
    id: "m1",
    role: "user",
    parts: [{ type: "text", text: "hi" }],
  },
  models: {
    thinking: { id: "m1", credentialId: "c1", limits: {} },
  },
  mode: "default",
  temperature: 0,
  toolApprovalLevel: "auto",
  user: { id: "u1", email: "u@x.com" },
  organizationId: "org1",
  currentThreadTitle: "Some existing title",
  signal: new AbortController().signal,
} as RunDecopilotCoreDeps["input"];

const baseRunContext: RunDecopilotCoreDeps["runContext"] = {
  virtualMcp: { id: "vir_1", metadata: {} },
};

const modelRuntime = {
  thinking: {
    model: { id: "m1", credentialId: "c1" },
    provider: {} as never,
  },
} as RunDecopilotCoreDeps["modelRuntime"];

// ── Tests ──────────────────────────────────────────────────────────────

describe("spawnSubtask", () => {
  test("returns text + usage from the child run's finish chunk", async () => {
    const chunks: UIMessageChunk[] = [
      { type: "text-delta", id: "1", delta: "Found " } as UIMessageChunk,
      { type: "text-delta", id: "1", delta: "12 things." } as UIMessageChunk,
      // The SDK's UI `finish` chunk carries the cumulative totalUsage, which
      // run-stream's messageMetadata callback turns into the final usage block.
      {
        type: "finish",
        totalUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      } as unknown as UIMessageChunk,
    ];
    const deps = {
      input: { ...baseInput, signal: new AbortController().signal },
      runContext: baseRunContext,
      modelRuntime,
      toolRuntime: makeToolRuntime({
        chunks,
        totalUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      }),
    };

    const result = await spawnSubtask({
      prompt: "Count the things",
      deps,
      signal: new AbortController().signal,
    });

    expect(result.text).toBe("Found 12 things.");
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });
    expect(result.error).toBeUndefined();
  });

  test("forwards SUBAGENT_STEP_LIMIT to the engine (step budget)", async () => {
    const captured: { args?: RunEngineArgs } = {};
    const deps = {
      input: { ...baseInput, signal: new AbortController().signal },
      runContext: baseRunContext,
      modelRuntime,
      toolRuntime: makeToolRuntime({
        chunks: [{ type: "finish" } as UIMessageChunk],
        totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        captured,
      }),
    };

    await spawnSubtask({
      prompt: "x",
      deps,
      signal: new AbortController().signal,
    });

    expect(captured.args?.stepLimit).toBe(SUBAGENT_STEP_LIMIT);
  });

  test("depth-1: a subtask run exposes no `subtask` tool to the engine", async () => {
    const captured: { args?: RunEngineArgs } = {};
    const deps = {
      input: { ...baseInput, signal: new AbortController().signal },
      runContext: baseRunContext,
      modelRuntime,
      toolRuntime: makeToolRuntime({
        chunks: [{ type: "finish" } as UIMessageChunk],
        totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        // Adapter handed back a toolset that DOES include subtask — the core
        // must strip it for a subtask run.
        tools: {
          subtask: { description: "d", inputSchema: {} } as never,
          other: { description: "d", inputSchema: {} } as never,
        } as ToolSet,
        captured,
      }),
    };

    await spawnSubtask({
      prompt: "x",
      deps,
      signal: new AbortController().signal,
    });

    // extraTools is what the engine actually sees for built-ins; subtask must
    // be absent. (The core strips it from tools.tools + tools.builtInTools.)
    expect(captured.args).toBeDefined();
    expect("subtask" in (captured.args!.extraTools ?? {})).toBe(false);
  });

  test("an already-aborted signal returns an error result cleanly", async () => {
    const ac = new AbortController();
    ac.abort(new Error("parent cancelled"));
    const deps = {
      input: { ...baseInput, signal: new AbortController().signal },
      runContext: baseRunContext,
      modelRuntime,
      toolRuntime: makeToolRuntime({
        chunks: [{ type: "finish" } as UIMessageChunk],
        totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      }),
    };

    // The semaphore acquire rejects on the aborted signal; spawnSubtask must
    // surface it rather than hang or throw uncaught.
    await expect(
      spawnSubtask({ prompt: "x", deps, signal: ac.signal }),
    ).rejects.toThrow("parent cancelled");
  });
});

describe("SUBTASK_MAX_CONCURRENT", () => {
  test("is a small positive cap", () => {
    expect(SUBTASK_MAX_CONCURRENT).toBeGreaterThan(0);
    expect(SUBTASK_MAX_CONCURRENT).toBeLessThanOrEqual(8);
  });
});

describe("runDecopilotCore conversation input", () => {
  test("uses DecopilotRunContext messages so hosted runs keep thread history", async () => {
    const input: RunDecopilotCoreDeps["input"] = {
      ...baseInput,
      signal: new AbortController().signal,
      userMessage: {
        id: "current",
        role: "user",
        parts: [{ type: "text", text: "current" }],
      },
    };
    const runContext: RunDecopilotCoreDeps["runContext"] = {
      virtualMcp: { id: "vir_1", metadata: {} },
      messages: [
        {
          id: "previous",
          role: "user",
          parts: [{ type: "text", text: "previous" }],
        },
        input.userMessage,
      ],
    };
    const captured: { args?: RunEngineArgs } = {};

    for await (const _ of runDecopilotCore({
      input,
      runContext,
      modelRuntime,
      toolRuntime: makeToolRuntime({
        chunks: [{ type: "finish" } as UIMessageChunk],
        totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        captured,
      }),
      kind: "main",
    })) {
      // drain
    }

    expect(captured.args?.messages).toHaveLength(2);
  });

  test("engine gets the run's read_tool_output map, not a fresh one", async () => {
    const input: RunDecopilotCoreDeps["input"] = {
      ...baseInput,
      signal: new AbortController().signal,
    };
    const captured: { args?: RunEngineArgs } = {};
    const bundleRef: { bundle?: HarnessAssembledTools } = {};

    for await (const _ of runDecopilotCore({
      input,
      runContext: baseRunContext,
      modelRuntime,
      toolRuntime: makeToolRuntime({
        chunks: [{ type: "finish" } as UIMessageChunk],
        totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        captured,
        bundleRef,
      }),
      kind: "main",
    })) {
      // drain
    }

    // The engine re-assembles the MCP tools. If it binds them to its own map,
    // every truncated MCP output is written where `read_tool_output` (bound to
    // the bundle's map via extraTools) can't see it — "Available ids: (none)".
    expect(captured.args?.toolOutputMap).toBe(bundleRef.bundle!.toolOutputMap);
    expect(captured.args?.virtualMcp.id).toBe("vir_1");
  });
});

describe("usage roll-up (parent final metadata includes child tokens)", () => {
  test("a main run folds onChildUsage into the parent's final finish usage", async () => {
    // Holder the test fills from buildEnvironmentTools' onChildUsage. A main
    // run wires this to usageAccumulator.addExternal.
    const holder: { onChildUsage?: (u: never) => void } = {};

    const finishChunk = {
      type: "finish",
      // Parent's OWN model usage on the finish chunk.
      totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    } as unknown as UIMessageChunk;

    const toolRuntime = {
      buildEnvironmentTools: async ({
        onChildUsage,
      }: {
        onChildUsage?: (u: never) => void;
      }) => {
        holder.onChildUsage = onChildUsage;
        return {
          tools: {} as ToolSet,
          passthroughTools: {} as ToolSet,
          builtInTools: {} as ToolSet,
          connectionsBlockTools: [],
          toolAnnotations: new Map(),
          connectionTitleMap: new Map(),
          serverInstructions: undefined,
          passthroughClient: {
            listTools: async () => ({ tools: [] }),
            listPrompts: async () => ({ prompts: [] }),
            getInstructions: () => "",
          } as never,
          toolOutputMap: new Map(),
          writer: { write: () => {}, merge: () => {} } as never,
          pendingImages: [],
          close: async () => {},
        } satisfies HarnessAssembledTools;
      },
      runEngine: async (): Promise<AssembledEngineHandle> => ({
        result: {
          finishReason: Promise.resolve("stop"),
          totalUsage: Promise.resolve({
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
          }),
          usage: Promise.resolve({
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
          }),
          request: Promise.resolve({}),
          response: Promise.resolve({ id: "r", messages: [] }),
          steps: Promise.resolve([]),
          toUIMessageStream: (opts?: {
            messageMetadata?: (a: { part: UIMessageChunk }) => unknown;
          }) => ({
            async *[Symbol.asyncIterator]() {
              // The subtask tool would call onChildUsage mid-stream as a child
              // run completes. Simulate that BEFORE the parent's finish chunk.
              holder.onChildUsage?.({
                inputTokens: 100,
                outputTokens: 50,
                totalTokens: 150,
              } as never);
              const md = opts?.messageMetadata?.({ part: finishChunk });
              yield { ...finishChunk, messageMetadata: md } as UIMessageChunk;
            },
          }),
        } as never,
        error: Promise.resolve(undefined),
        span: fakeSpan(),
        assembledSystemMessages: [],
      }),
    };

    const deps: RunDecopilotCoreDeps = {
      input: {
        ...baseInput,
        signal: new AbortController().signal,
        userMessage: {
          id: "u-1",
          role: "user",
          parts: [{ type: "text", text: "hi" }],
        },
      },
      runContext: baseRunContext,
      modelRuntime,
      toolRuntime: toolRuntime as never,
      kind: "main",
    };

    let finalUsage:
      | { inputTokens: number; outputTokens: number; totalTokens: number }
      | undefined;
    for await (const chunk of runDecopilotCore(deps)) {
      const c = chunk as {
        type: string;
        messageMetadata?: { usage?: typeof finalUsage };
      };
      if (c.type === "finish" && c.messageMetadata?.usage) {
        finalUsage = c.messageMetadata.usage;
      }
    }

    // Parent (10/5/15) + child (100/50/150) = 110/55/165.
    expect(finalUsage?.inputTokens).toBe(110);
    expect(finalUsage?.outputTokens).toBe(55);
    expect(finalUsage?.totalTokens).toBe(165);
  });
});

describe("runDecopilotCore main-run subtask policy", () => {
  test("a main run does NOT strip the subtask tool (depth-1 is subtask-only)", async () => {
    const captured: { args?: RunEngineArgs } = {};
    const deps: RunDecopilotCoreDeps = {
      input: {
        ...baseInput,
        signal: new AbortController().signal,
        userMessage: {
          id: "u-1",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        },
      },
      runContext: baseRunContext,
      modelRuntime,
      toolRuntime: makeToolRuntime({
        chunks: [{ type: "finish" } as UIMessageChunk],
        totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        tools: {
          subtask: { description: "d", inputSchema: {} } as never,
        } as ToolSet,
        captured,
      }),
      kind: "main",
    };

    for await (const _ of runDecopilotCore(deps)) {
      // drain
    }

    expect("subtask" in (captured.args!.extraTools ?? {})).toBe(true);
    // Main runs don't impose the subtask step budget.
    expect(captured.args?.stepLimit).toBeUndefined();
  });
});
