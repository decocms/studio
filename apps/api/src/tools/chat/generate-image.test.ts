import { describe, expect, it } from "bun:test";
import { MockImageModelV4 } from "ai/test";
import { parseStudioStorageKey } from "@/harnesses/lib/decopilot/studio-storage-uri";
import { GENERATE_IMAGE } from "./generate-image";
import { chatToolContext } from "./test-helpers";

const PNG_BASE64 = Buffer.from("png-bytes").toString("base64");

function contextWithImageModel(calls: string[]) {
  return chatToolContext({
    aiProviders: {
      listModels: async () => [],
      activate: async (credentialId: string) => ({
        aiSdk: {
          imageModel: (modelId: string) => {
            calls.push(`${credentialId}/${modelId}`);
            return new MockImageModelV4({
              doGenerate: async () => ({
                images: [PNG_BASE64],
                warnings: [],
                response: { timestamp: new Date(), modelId, headers: {} },
              }),
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
