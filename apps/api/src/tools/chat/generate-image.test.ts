import { describe, expect, it } from "bun:test";
import { MockImageModelV4 } from "ai/test";
import { parseStudioStorageKey } from "@/harnesses/lib/decopilot/studio-storage-uri";
import { GENERATE_IMAGE } from "./generate-image";
import { chatToolContext } from "./test-helpers";

const PNG_BASE64 = Buffer.from("png-bytes").toString("base64");

function contextWithImageModel(
  calls: string[],
  requests: unknown[] = [],
  overrides: Record<string, unknown> = {},
) {
  return chatToolContext({
    ...overrides,
    aiProviders: {
      listModels: async () => [],
      activate: async (credentialId: string) => ({
        info: { id: "openrouter" },
        aiSdk: {
          imageModel: (modelId: string) => {
            calls.push(`${credentialId}/${modelId}`);
            return new MockImageModelV4({
              doGenerate: async (options) => {
                requests.push(options);
                return {
                  images: [PNG_BASE64],
                  warnings: [],
                  response: { timestamp: new Date(), modelId, headers: {} },
                };
              },
            });
          },
        },
      }),
    },
  });
}

describe("generate_image", () => {
  it("generates on the org's image tier and stores the image", async () => {
    const calls: string[] = [];
    const ctx = contextWithImageModel(calls);
    const result = await GENERATE_IMAGE.handler({ prompt: "a red fox" }, ctx);

    expect(calls).toEqual(["key_1/image-model"]);
    expect(result.model).toBe("image-model");
    expect(result.images).toHaveLength(1);
    const key = parseStudioStorageKey(result.images[0]!.uri);
    expect(key).toStartWith("generated-images/");
  });

  it("runs the requested model, size and OpenAI options on the OpenRouter key", async () => {
    const calls: string[] = [];
    const requests: unknown[] = [];
    const keys = [
      { id: "key_deco", providerId: "deco" },
      { id: "key_or", providerId: "openrouter" },
    ];
    const ctx = contextWithImageModel(calls, requests, {
      storage: { aiProviderKeys: { list: async () => keys } },
    });
    const result = await GENERATE_IMAGE.handler(
      {
        prompt: "a red fox",
        provider: "openrouter",
        model: "openai/gpt-image",
        size: "1536x1920",
        aspectRatio: "1:1",
        quality: "high",
        moderation: "low",
      },
      ctx,
    );

    expect(calls).toEqual(["key_or/openai/gpt-image"]);
    expect(result.model).toBe("openai/gpt-image");
    expect(requests[0]).toMatchObject({
      size: "1536x1920",
      aspectRatio: undefined,
      providerOptions: {
        openrouter: {
          quality: "high",
          provider: { options: { openai: { moderation: "low" } } },
        },
      },
    });
  });

  it("refuses a reference image on a private address", async () => {
    const ctx = contextWithImageModel([]);
    await expect(
      GENERATE_IMAGE.handler(
        {
          prompt: "like this",
          referenceImages: [{ uri: "https://169.254.169.254/latest" }],
        },
        ctx,
      ),
    ).rejects.toThrow(/private network/);
  });

  it("fails before generating when there is no object storage", async () => {
    const calls: string[] = [];
    const ctx = contextWithImageModel(calls);
    await expect(
      GENERATE_IMAGE.handler(
        { prompt: "a red fox" },
        { ...ctx, objectStorage: null },
      ),
    ).rejects.toThrow(/Object storage is unavailable/);
    expect(calls).toEqual([]);
  });
});
