import { describe, expect, test } from "bun:test";
import { recordLlmCallMetrics } from "./record-llm-call-metrics";

interface CounterCall {
  name: string;
  add: number;
  attributes: Record<string, string>;
}

function makeFakeMeter(calls: CounterCall[]) {
  return {
    createCounter(name: string) {
      return {
        add(value: number, attributes: Record<string, string>) {
          calls.push({ name, add: value, attributes });
        },
      };
    },
    createHistogram(_name: string) {
      return { record() {} };
    },
  };
}

function makeCtx(meter: ReturnType<typeof makeFakeMeter>) {
  // biome-ignore lint/suspicious/noExplicitAny: test fixture mocks StudioContext shape
  return { meter } as any;
}

describe("recordLlmCallMetrics — cache tokens", () => {
  test("emits cache_tokens counter with kind=read and kind=write", () => {
    const calls: CounterCall[] = [];
    const meter = makeFakeMeter(calls);

    recordLlmCallMetrics({
      ctx: makeCtx(meter),
      organizationId: "org_1",
      modelId: "claude-sonnet-4-6",
      durationMs: 100,
      isError: false,
      inputTokens: 1000,
      outputTokens: 50,
      cacheWriteTokens: 300,
      cacheReadTokens: 8000,
    });

    const cacheCalls = calls.filter(
      (c) => c.name === "tool.execution.cache_tokens",
    );
    expect(cacheCalls).toHaveLength(2);

    const write = cacheCalls.find((c) => c.attributes.kind === "write");
    const read = cacheCalls.find((c) => c.attributes.kind === "read");
    expect(write?.add).toBe(300);
    expect(read?.add).toBe(8000);
    expect(write?.attributes["tool.name"]).toBe("claude-sonnet-4-6");
    expect(read?.attributes["organization.id"]).toBe("org_1");
  });

  test("emits no cache_tokens counter when both fields are zero/absent", () => {
    const calls: CounterCall[] = [];
    const meter = makeFakeMeter(calls);

    recordLlmCallMetrics({
      ctx: makeCtx(meter),
      organizationId: "org_1",
      modelId: "claude-sonnet-4-6",
      durationMs: 100,
      isError: false,
      inputTokens: 1000,
      outputTokens: 50,
    });

    const cacheCalls = calls.filter(
      (c) => c.name === "tool.execution.cache_tokens",
    );
    expect(cacheCalls).toHaveLength(0);
  });

  test("emits only the non-zero kind when one is zero", () => {
    const calls: CounterCall[] = [];
    const meter = makeFakeMeter(calls);

    recordLlmCallMetrics({
      ctx: makeCtx(meter),
      organizationId: "org_1",
      modelId: "claude-sonnet-4-6",
      durationMs: 100,
      isError: false,
      cacheWriteTokens: 0,
      cacheReadTokens: 5000,
    });

    const cacheCalls = calls.filter(
      (c) => c.name === "tool.execution.cache_tokens",
    );
    expect(cacheCalls).toHaveLength(1);
    expect(cacheCalls[0]!.attributes.kind).toBe("read");
    expect(cacheCalls[0]!.add).toBe(5000);
  });
});
