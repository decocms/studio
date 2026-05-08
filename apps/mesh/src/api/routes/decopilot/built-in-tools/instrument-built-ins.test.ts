/**
 * Tests for instrumentBuiltIns wrapper.
 *
 * The AI SDK's executeTool checks isAsyncIterable on the value returned from
 * tool.execute(). If a tool's execute is `async function*` (a generator),
 * wrapping it in a plain `async function` produces a Promise — and the AI SDK
 * never iterates it, dropping every preliminary yield and capturing the bare
 * generator object as the final output. That's how `subtask` results showed
 * "No output available" on every call. These tests pin the wrapper down so the
 * generator surface survives instrumentation.
 */

import { describe, expect, test } from "bun:test";
import { instrumentBuiltIns, type BuiltinToolParams } from "./index";

const mockParams: BuiltinToolParams = {
  provider: null,
  organization: { id: "org_test" } as never,
  models: { connectionId: "conn_test", thinking: { id: "m" } } as never,
  toolOutputMap: new Map(),
  pendingImages: [],
  passthroughClient: {} as never,
  taskId: "task_test",
};

const mockCtx = { auth: { user: { id: "user_test" } } } as never;

describe("instrumentBuiltIns", () => {
  test("preserves async-generator execute as async-iterable and yields all values", async () => {
    const yielded = ["a", "b", "final"];
    const tools = {
      gen_tool: {
        description: "test gen tool",
        execute: async function* (_input: unknown, _options: unknown) {
          for (const v of yielded) yield v;
        },
      },
    };

    const wrapped = instrumentBuiltIns(tools, mockParams, mockCtx);
    const result = wrapped.gen_tool.execute({}, {});

    expect(
      typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator],
    ).toBe("function");

    const collected: unknown[] = [];
    for await (const v of result as AsyncIterable<unknown>) {
      collected.push(v);
    }
    expect(collected).toEqual(yielded);
  });

  test("propagates errors thrown inside async-generator execute", async () => {
    const tools = {
      gen_throws: {
        description: "throws",
        execute: async function* (_input: unknown, _options: unknown) {
          yield "first";
          throw new Error("boom");
        },
      },
    };

    const wrapped = instrumentBuiltIns(tools, mockParams, mockCtx);
    const collected: unknown[] = [];
    let caught: unknown;
    try {
      for await (const v of wrapped.gen_throws.execute(
        {},
        {},
      ) as AsyncIterable<unknown>) {
        collected.push(v);
      }
    } catch (err) {
      caught = err;
    }
    expect(collected).toEqual(["first"]);
    expect((caught as Error)?.message).toBe("boom");
  });

  test("keeps plain async execute working unchanged", async () => {
    const tools = {
      plain_tool: {
        description: "plain",
        execute: async (input: { n: number }, _options: unknown) => ({
          doubled: input.n * 2,
        }),
      },
    };

    const wrapped = instrumentBuiltIns(tools, mockParams, mockCtx);
    const result = await wrapped.plain_tool.execute({ n: 21 }, {});
    expect(result).toEqual({ doubled: 42 });
  });
});
