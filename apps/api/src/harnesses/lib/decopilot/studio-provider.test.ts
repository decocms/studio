import { describe, expect, test } from "bun:test";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { createLanguageModel } from "./studio-provider";

function fakeModel(
  id: string,
  impl: { doGenerate?: () => Promise<never> },
): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "test",
    modelId: id,
    supportedUrls: {},
    doGenerate: impl.doGenerate ?? (() => Promise.reject(new Error("unused"))),
    doStream: () => Promise.reject(new Error("unused")),
  } as unknown as LanguageModelV4;
}

describe("createLanguageModel credit fallback", () => {
  test("surfaces the original credit error when the free retry also fails", async () => {
    const creditError = Object.assign(new Error("insufficient credits"), {
      statusCode: 402,
    });
    const freeError = new Error("free model rate limited");
    const provider = {
      info: { id: "openrouter" },
      aiSdk: {
        languageModel: (id: string) =>
          id === "openrouter/free"
            ? fakeModel(id, { doGenerate: () => Promise.reject(freeError) })
            : fakeModel(id, { doGenerate: () => Promise.reject(creditError) }),
      },
    };

    const model = createLanguageModel(provider, { id: "anthropic/claude" });

    await expect(model.doGenerate({ prompt: [] } as never)).rejects.toThrow(
      "insufficient credits",
    );
  });
});
