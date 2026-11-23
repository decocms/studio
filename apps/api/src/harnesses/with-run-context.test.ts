import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HARNESS_RUN_CONTEXT_MAX_BYTES } from "@decocms/sandbox/dispatch/schemas";
import type { UIMessageChunk } from "ai";
import { PartRowBuilder } from "@/api/routes/decopilot/part-row-builder";
import { projectChunks } from "@/api/routes/decopilot/project-chunks";
import { withModelMetadata } from "./with-model-metadata";
import { withRunContext } from "./with-run-context";

const context = {
  runner: { version: "0.18.0", image: "1.108.1", cli: "2.1.280" },
  model: "claude-sonnet-5-5",
  effort: "medium",
  permissionMode: "bypassPermissions",
  tools: { count: 2, names: ["Bash", "Read"] },
  deferredTools: { count: 1, names: ["mcp__studio__web_search"] },
  skills: { count: 3, org: 2, names: ["dataviz"] },
  mcpServers: { count: 1, servers: [{ name: "studio", status: "connected" }] },
  agents: { count: 1, names: ["general-purpose"] },
  memory: true,
  systemPromptAppendChars: 1234,
};
const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3 };

const finish = (messageMetadata?: unknown) =>
  ({
    type: "finish",
    finishReason: "stop",
    ...(messageMetadata === undefined ? {} : { messageMetadata }),
  }) as UIMessageChunk;

/** One runner turn, as the daemon relays it. */
function turn(last: UIMessageChunk): AsyncIterable<UIMessageChunk> {
  return (async function* () {
    yield { type: "start", messageId: "msg_1" } as UIMessageChunk;
    yield { type: "start-step" } as UIMessageChunk;
    yield { type: "text-start", id: "t" } as UIMessageChunk;
    yield { type: "text-delta", id: "t", delta: "done" } as UIMessageChunk;
    yield { type: "text-end", id: "t" } as UIMessageChunk;
    yield { type: "finish-step" } as UIMessageChunk;
    yield last;
  })();
}

async function collect(
  source: AsyncIterable<UIMessageChunk>,
): Promise<UIMessageChunk[]> {
  const out: UIMessageChunk[] = [];
  for await (const chunk of source) out.push(chunk);
  return out;
}

const metadataOf = (chunk: UIMessageChunk | undefined) =>
  (chunk as { messageMetadata?: Record<string, unknown> } | undefined)
    ?.messageMetadata;

let warned: unknown[][] = [];
const realWarn = console.warn;
beforeEach(() => {
  warned = [];
  console.warn = (...args: unknown[]) => {
    warned.push(args);
  };
});
afterEach(() => {
  console.warn = realWarn;
});

describe("withRunContext", () => {
  test("a context that parses goes through as the runner sent it", async () => {
    const sent = finish({ usage, context });
    const out = await collect(withRunContext(turn(sent)));
    expect(out.at(-1)).toBe(sent);
    expect(warned).toEqual([]);
  });

  test("a newer runner's extra fields are kept", async () => {
    const newer = {
      ...context,
      sessions: 2,
      runner: { ...context.runner, sdk: "0.3.280" },
    };
    const out = await collect(withRunContext(turn(finish({ context: newer }))));
    expect(metadataOf(out.at(-1))?.context).toEqual(newer);
  });

  test("a truncated context, lists dropped, parses", async () => {
    const truncated = {
      ...context,
      tools: { count: 500 },
      deferredTools: { count: 400 },
      truncated: true,
    };
    const out = await collect(
      withRunContext(turn(finish({ context: truncated }))),
    );
    expect(metadataOf(out.at(-1))?.context).toEqual(truncated);
  });

  test("an old runner's chunks, without the field, are untouched", async () => {
    const chunks = await collect(turn(finish({ usage })));
    const out = await collect(
      withRunContext(
        (async function* () {
          yield* chunks;
        })(),
      ),
    );
    expect(out).toHaveLength(chunks.length);
    for (const [index, chunk] of out.entries()) {
      expect(chunk).toBe(chunks[index] as UIMessageChunk);
    }
    const bare = finish();
    expect((await collect(withRunContext(turn(bare)))).at(-1)).toBe(bare);
  });

  test.each([
    ["a string", "runner 0.18.0"],
    ["null", null],
    ["no runner version", { ...context, runner: {} }],
    ["a list that is not one", { ...context, tools: { count: 2, names: "x" } }],
    ["a negative count", { ...context, skills: { count: -1 } }],
    [
      "a name longer than a name",
      { ...context, agents: { count: 1, names: ["a".repeat(300)] } },
    ],
    ["a memory path", { ...context, memory: "/app/org/home/users/user_1" }],
  ])("drops %s and keeps the rest of the metadata", async (_name, bad) => {
    const out = await collect(
      withRunContext(turn(finish({ usage, context: bad }))),
    );
    expect(out).toHaveLength(7);
    expect(out.at(-1)).toEqual(finish({ usage }));
    expect(warned).toHaveLength(1);
  });

  test("drops a context larger than the cap, and says why without its content", async () => {
    const names = Array.from({ length: 400 }, (_, i) => `mcp__studio__T_${i}`);
    const large = { ...context, tools: { count: 400, names } };
    expect(JSON.stringify(large).length).toBeGreaterThan(
      HARNESS_RUN_CONTEXT_MAX_BYTES,
    );
    const out = await collect(
      withRunContext(turn(finish({ usage, context: large }))),
    );
    expect(out.at(-1)).toEqual(finish({ usage }));
    expect(JSON.stringify(warned)).not.toContain("mcp__studio__T_1");
  });
});

describe("a sandbox run's finish row", () => {
  /** The rows a run's chunks are stored as, through the fold the projector uses. */
  async function rowsFor(last: UIMessageChunk, validate = true) {
    const builder = new PartRowBuilder({
      orgId: "org_example",
      threadId: "thread_example",
      runId: "thread_example",
    });
    const rows: ReturnType<PartRowBuilder["emitFinal"]> = [];
    const result = await projectChunks({
      chunks: withModelMetadata(
        validate ? withRunContext(turn(last)) : turn(last),
        "claude-sonnet-5-5",
        "deco",
      ),
      persistence: {
        emitStepParts: async (message) => {
          const emitted = builder.emitStepParts(message);
          builder.acknowledge(emitted);
          rows.push(...emitted);
        },
        emitFinal: async (message) => {
          rows.push(...builder.emitFinal(message));
        },
        emitError: async (id, text) => {
          rows.push(...builder.emitError(id, text));
        },
      },
    });
    return { result, finishRow: rows.find((row) => row.kind === "finish") };
  }

  test("stores the context next to models and usage", async () => {
    const { result, finishRow } = await rowsFor(finish({ usage, context }));
    expect(result.failed).toBe(false);
    expect(finishRow?.metadata).toMatchObject({
      models: { thinking: { id: "claude-sonnet-5-5" } },
      usage,
      context,
    });
  });

  test("a malformed context costs the run nothing but the context", async () => {
    const { result, finishRow } = await rowsFor(
      finish({ usage, context: { runner: { version: 18 } } }),
    );
    expect(result).toMatchObject({ failed: false, finishReason: "stop" });
    expect(finishRow?.metadata).toMatchObject({ usage });
    expect(finishRow?.metadata).not.toHaveProperty("context");
  });

  test("a Studio that predates the field stores the run, context included", async () => {
    const { result, finishRow } = await rowsFor(
      finish({ usage, context }),
      false,
    );
    expect(result).toMatchObject({ failed: false, finishReason: "stop" });
    expect(finishRow?.metadata).toMatchObject({ usage, context });
  });

  test("an old runner's run is stored as before", async () => {
    const { result, finishRow } = await rowsFor(finish({ usage }));
    expect(result.failed).toBe(false);
    expect(finishRow?.metadata).toEqual({
      models: {
        thinking: {
          id: "claude-sonnet-5-5",
          title: "claude-sonnet-5-5",
          provider: "deco",
        },
      },
      usage,
      finishReason: "stop",
    });
  });
});
