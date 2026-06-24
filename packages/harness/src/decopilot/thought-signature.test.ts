import { describe, expect, it } from "bun:test";
import { convertToModelMessages, type UIMessage } from "ai";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from "@ai-sdk/provider";
import {
  joinThoughtSignature,
  splitThoughtSignature,
  thoughtSignatureMiddleware,
} from "./thought-signature";

const SIG = "EvACCu0CAQw51sdR" + "Z".repeat(4000); // multi-KB, like a real signature

function streamOf(
  parts: LanguageModelV3StreamPart[],
): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });
}

async function drain(
  stream: ReadableStream<LanguageModelV3StreamPart>,
): Promise<LanguageModelV3StreamPart[]> {
  const out: LanguageModelV3StreamPart[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

describe("split/join thought signature", () => {
  it("returns a null signature for a normal id (no-op path)", () => {
    expect(splitThoughtSignature("call_abc123")).toEqual({
      baseId: "call_abc123",
      signature: null,
    });
    expect(splitThoughtSignature("toolu_01XYZ")).toEqual({
      baseId: "toolu_01XYZ",
      signature: null,
    });
  });

  it("splits a gateway-bloated id into base + signature", () => {
    const id = `call_9e0c__thought__${SIG}`;
    expect(splitThoughtSignature(id)).toEqual({
      baseId: "call_9e0c",
      signature: SIG,
    });
  });

  it("round-trips: join(split(x)) === x", () => {
    const id = `call_9e0c__thought__${SIG}`;
    const { baseId, signature } = splitThoughtSignature(id);
    expect(joinThoughtSignature(baseId, signature!)).toBe(id);
  });

  it("splits on the FIRST separator (signatures can be arbitrary base64)", () => {
    const id = "call_x__thought__aaa__thought__bbb";
    expect(splitThoughtSignature(id)).toEqual({
      baseId: "call_x",
      signature: "aaa__thought__bbb",
    });
  });
});

describe("thoughtSignatureMiddleware — inbound strip (wrapStream)", () => {
  it("strips the signature off every tool stream part and stashes it in google metadata", async () => {
    const mw = thoughtSignatureMiddleware();
    const fullId = `call_9e0c__thought__${SIG}`;
    const result = await mw.wrapStream!({
      doStream: async () =>
        ({
          stream: streamOf([
            { type: "tool-input-start", id: fullId, toolName: "web_search" },
            { type: "tool-input-delta", id: fullId, delta: '{"q":1}' },
            { type: "tool-input-end", id: fullId },
            {
              type: "tool-call",
              toolCallId: fullId,
              toolName: "web_search",
              input: '{"q":1}',
            },
          ]),
        }) as LanguageModelV3StreamResult,
      // biome-ignore lint/suspicious/noExplicitAny: unused middleware arg
      doGenerate: (async () => ({})) as any,
      params: {} as LanguageModelV3CallOptions,
      // biome-ignore lint/suspicious/noExplicitAny: unused middleware arg
      model: {} as any,
    });

    const parts = await drain(result.stream);
    // Every part now carries the base id only.
    for (const p of parts) {
      const id = "id" in p ? p.id : "toolCallId" in p ? p.toolCallId : null;
      expect(id).toBe("call_9e0c");
    }
    const call = parts.find((p) => p.type === "tool-call");
    expect(
      // biome-ignore lint/suspicious/noExplicitAny: provider metadata probe
      (call as any).providerMetadata.google.thoughtSignature,
    ).toBe(SIG);
  });

  it("passes a normal stream through untouched", async () => {
    const mw = thoughtSignatureMiddleware();
    const result = await mw.wrapStream!({
      doStream: async () =>
        ({
          stream: streamOf([
            {
              type: "tool-call",
              toolCallId: "call_plain",
              toolName: "web_search",
              input: "{}",
            },
          ]),
        }) as LanguageModelV3StreamResult,
      // biome-ignore lint/suspicious/noExplicitAny: unused middleware arg
      doGenerate: (async () => ({})) as any,
      params: {} as LanguageModelV3CallOptions,
      // biome-ignore lint/suspicious/noExplicitAny: unused middleware arg
      model: {} as any,
    });
    const parts = await drain(result.stream);
    const call = parts.find((p) => p.type === "tool-call");
    expect((call as { toolCallId: string }).toolCallId).toBe("call_plain");
    // biome-ignore lint/suspicious/noExplicitAny: provider metadata probe
    expect((call as any).providerMetadata).toBeUndefined();
  });
});

describe("thoughtSignatureMiddleware — inbound strip (wrapGenerate)", () => {
  it("strips tool-call content parts", async () => {
    const mw = thoughtSignatureMiddleware();
    const result = await mw.wrapGenerate!({
      doGenerate: async () =>
        ({
          content: [
            {
              type: "tool-call",
              toolCallId: `call_9e0c__thought__${SIG}`,
              toolName: "web_search",
              input: "{}",
            },
          ],
          finishReason: "tool-calls",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        }) as unknown as LanguageModelV3GenerateResult,
      // biome-ignore lint/suspicious/noExplicitAny: unused middleware arg
      doStream: (async () => ({})) as any,
      params: {} as LanguageModelV3CallOptions,
      // biome-ignore lint/suspicious/noExplicitAny: unused middleware arg
      model: {} as any,
    });
    const call = result.content.find((p) => p.type === "tool-call");
    expect((call as { toolCallId: string }).toolCallId).toBe("call_9e0c");
    expect(
      // biome-ignore lint/suspicious/noExplicitAny: provider metadata probe
      (call as any).providerMetadata.google.thoughtSignature,
    ).toBe(SIG);
  });
});

describe("thoughtSignatureMiddleware — outbound reembed (transformParams)", () => {
  it("re-embeds the signature into both the tool-call and matching tool-result id", async () => {
    const mw = thoughtSignatureMiddleware();
    const params = {
      prompt: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_9e0c",
              toolName: "web_search",
              input: "{}",
              providerOptions: { google: { thoughtSignature: SIG } },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_9e0c",
              toolName: "web_search",
              output: { type: "json", value: { ok: true } },
            },
          ],
        },
      ],
    } as unknown as LanguageModelV3CallOptions;

    const out = await mw.transformParams!({
      type: "stream",
      params,
      // biome-ignore lint/suspicious/noExplicitAny: unused middleware arg
      model: {} as any,
    });

    const expected = `call_9e0c__thought__${SIG}`;
    // biome-ignore lint/suspicious/noExplicitAny: prompt shape probe
    const prompt = out.prompt as any[];
    expect(prompt[0].content[0].toolCallId).toBe(expected);
    expect(prompt[1].content[0].toolCallId).toBe(expected);
  });

  it("is a no-op when no tool-call carries a signature", async () => {
    const mw = thoughtSignatureMiddleware();
    const params = {
      prompt: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_plain",
              toolName: "web_search",
              input: "{}",
            },
          ],
        },
      ],
    } as unknown as LanguageModelV3CallOptions;
    const out = await mw.transformParams!({
      type: "stream",
      params,
      // biome-ignore lint/suspicious/noExplicitAny: unused middleware arg
      model: {} as any,
    });
    expect(out).toBe(params);
  });
});

describe("persistence → model bridge (convertToModelMessages)", () => {
  it("carries callProviderMetadata.google.thoughtSignature onto the model tool-call providerOptions", async () => {
    // A persisted assistant tool part: the reader stores a tool-call's
    // providerMetadata as `callProviderMetadata`, which convertToModelMessages
    // maps to `providerOptions` — the channel transformParams reads back.
    const uiMessages: UIMessage[] = [
      {
        id: "m1",
        role: "assistant",
        parts: [
          {
            type: "tool-web_search",
            toolCallId: "call_9e0c",
            state: "output-available",
            input: { query: "q" },
            output: { success: true },
            callProviderMetadata: { google: { thoughtSignature: SIG } },
          },
        ],
        // biome-ignore lint/suspicious/noExplicitAny: minimal UI message fixture
      } as any,
    ];

    const model = await convertToModelMessages(uiMessages);
    const assistant = model.find((m) => m.role === "assistant");
    const toolCall = (
      assistant!.content as Array<{ type: string; providerOptions?: unknown }>
    ).find((p) => p.type === "tool-call");
    expect(
      // biome-ignore lint/suspicious/noExplicitAny: provider options probe
      (toolCall as any).providerOptions.google.thoughtSignature,
    ).toBe(SIG);
  });
});
