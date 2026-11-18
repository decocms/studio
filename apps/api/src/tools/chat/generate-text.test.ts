import { describe, expect, it } from "bun:test";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { GENERATE_TEXT } from "./generate-text";
import { chatToolContext } from "./test-helpers";

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PNG_DATA_URI = `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`;

function contextWithTextModel(
  calls: string[],
  requests: LanguageModelV4CallOptions[] = [],
  overrides: Record<string, unknown> = {},
  providerId = "openrouter",
) {
  return chatToolContext({
    ...overrides,
    aiProviders: {
      listModels: async () => [],
      activate: async (credentialId: string) => ({
        info: { id: providerId },
        aiSdk: {
          languageModel: (modelId: string) => {
            calls.push(`${credentialId}/${modelId}`);
            return new MockLanguageModelV4({
              doGenerate: async (options) => {
                requests.push(options);
                return {
                  content: [{ type: "text", text: '{"color":"mustard"}' }],
                  finishReason: { unified: "stop", raw: "stop" },
                  usage: {
                    inputTokens: {
                      total: 12,
                      noCache: 12,
                      cacheRead: 0,
                      cacheWrite: 0,
                    },
                    outputTokens: { total: 5, text: 5, reasoning: 0 },
                  },
                  warnings: [],
                };
              },
            });
          },
        },
      }),
    },
  });
}

describe("generate_text", () => {
  it("answers on the org's smart tier, the chat's model", async () => {
    const calls: string[] = [];
    const requests: LanguageModelV4CallOptions[] = [];
    const result = await GENERATE_TEXT.handler(
      { prompt: "Describe the garment", system: "Return JSON" },
      contextWithTextModel(calls, requests),
    );

    expect(calls).toEqual(["key_1/text-model"]);
    expect(result).toEqual({
      success: true,
      text: '{"color":"mustard"}',
      model: "text-model",
      usage: { inputTokens: 12, outputTokens: 5 },
    });
    expect(requests[0]!.prompt[0]).toEqual({
      role: "system",
      content: "Return JSON",
    });
  });

  it("sends the images with the message, read through the reference guards", async () => {
    const requests: LanguageModelV4CallOptions[] = [];
    await GENERATE_TEXT.handler(
      { prompt: "What color is it?", images: [{ uri: PNG_DATA_URI }] },
      contextWithTextModel([], requests),
    );

    const message = requests[0]!.prompt[0]!;
    expect(message.role).toBe("user");
    const parts = message.content as Array<{ type: string }>;
    expect(parts.map((part) => part.type)).toEqual(["text", "file"]);
    expect(parts[1]).toMatchObject({ mediaType: "image/png" });
  });

  it("refuses an image on a private address before calling the model", async () => {
    const calls: string[] = [];
    await expect(
      GENERATE_TEXT.handler(
        {
          prompt: "What is this?",
          images: [{ uri: "https://169.254.169.254/latest" }],
        },
        contextWithTextModel(calls),
      ),
    ).rejects.toThrow(/private network/);
    expect(calls).toEqual([]);
  });

  it("runs the requested model on the org's key of a provider", async () => {
    const calls: string[] = [];
    const keys = [
      { id: "key_deco", providerId: "deco" },
      { id: "key_or", providerId: "openrouter" },
    ];
    const result = await GENERATE_TEXT.handler(
      {
        prompt: "Describe the garment",
        provider: "openrouter",
        model: "anthropic/claude-opus",
      },
      contextWithTextModel(calls, [], {
        storage: { aiProviderKeys: { list: async () => keys } },
      }),
    );

    expect(calls).toEqual(["key_or/anthropic/claude-opus"]);
    expect(result.model).toBe("anthropic/claude-opus");
  });

  it("needs a model with a provider, and a key of that provider", async () => {
    const ctx = contextWithTextModel([]);
    await expect(
      GENERATE_TEXT.handler({ prompt: "hi", provider: "openrouter" }, ctx),
    ).rejects.toThrow(/provider needs a model/);
    await expect(
      GENERATE_TEXT.handler(
        { prompt: "hi", provider: "anthropic", model: "claude" },
        ctx,
      ),
    ).rejects.toThrow(/has no anthropic key/);
  });
});
