import { describe, expect, it } from "bun:test";
import { runNativeAgentLoopCore } from "./native-agent-loop-core";

describe("runNativeAgentLoopCore", () => {
  it("passes shared stream options through and captures provider errors", async () => {
    let capturedConfig:
      | {
          messages: unknown[];
          tools: Record<string, unknown>;
          temperature: number;
          maxOutputTokens: number;
          onError: (event: { error: unknown }) => void | Promise<void>;
        }
      | undefined;

    const fakeResult = {
      finishReason: Promise.resolve("error"),
      toUIMessageStream: () => ({
        async *[Symbol.asyncIterator]() {},
      }),
    };

    const handle = runNativeAgentLoopCore({
      model: { specificationVersion: "v2" } as never,
      systemMessages: [{ role: "system", content: "system" }],
      messages: [{ role: "user", content: "hi" }] as never,
      tools: { user_ask: {} as never } as never,
      temperature: 0.2,
      maxOutputTokens: 1234,
      stopWhen: () => false,
      abortSignal: new AbortController().signal,
      streamText: (config) => {
        capturedConfig = config as typeof capturedConfig;
        Promise.resolve().then(() =>
          capturedConfig?.onError({ error: new Error("provider exploded") }),
        );
        return fakeResult as never;
      },
    });

    expect(capturedConfig?.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(Object.keys(capturedConfig?.tools ?? {})).toEqual(["user_ask"]);
    expect(capturedConfig?.temperature).toBe(0.2);
    expect(capturedConfig?.maxOutputTokens).toBe(1234);
    await expect(handle.error).resolves.toContain("provider exploded");
  });
});
