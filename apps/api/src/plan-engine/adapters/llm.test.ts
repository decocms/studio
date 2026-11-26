import { describe, expect, it } from "bun:test";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import type { StudioContext } from "@/core/studio-context";
import { chatToolContext } from "@/tools/chat/test-helpers";
import { type LlmUsage, NO_AI_MODEL, NoAiModelError } from "../ports.ts";
import { hasEngineModel, LlmTruncatedError, orgLlm } from "./llm.ts";

function contextWith(answer: {
  text: string;
  finish?: "stop" | "length";
  cost?: number;
}) {
  const calls: string[] = [];
  const requests: LanguageModelV4CallOptions[] = [];
  const ctx = chatToolContext({
    aiProviders: {
      listModels: async () => [],
      activate: async (credentialId: string) => ({
        info: { id: "openrouter" },
        aiSdk: {
          languageModel: (modelId: string) => {
            calls.push(`${credentialId}/${modelId}`);
            return new MockLanguageModelV4({
              supportedUrls: { "image/*": [/^https:\/\//] },
              doGenerate: async (options) => {
                requests.push(options);
                return {
                  content: [{ type: "text", text: answer.text }],
                  finishReason: {
                    unified: answer.finish ?? "stop",
                    raw: answer.finish ?? "stop",
                  },
                  usage: {
                    inputTokens: {
                      total: 120,
                      noCache: 120,
                      cacheRead: 0,
                      cacheWrite: 0,
                    },
                    outputTokens: { total: 30, text: 30, reasoning: 0 },
                  },
                  ...(answer.cost !== undefined
                    ? {
                        providerMetadata: {
                          openrouter: { usage: { cost: answer.cost } },
                        },
                      }
                    : {}),
                  warnings: [],
                };
              },
            });
          },
        },
      }),
    },
  });
  return { ctx, calls, requests };
}

describe("orgLlm", () => {
  it("asks the org's tier model and reports what the provider billed", async () => {
    const { ctx, calls, requests } = contextWith({ text: "{}", cost: 0.0042 });
    const usage: LlmUsage[] = [];
    const text = await orgLlm(ctx)(
      {
        tier: "smart",
        systemPrompt: "sys",
        userPrompt: "user",
        contentParts: [
          { type: "text", text: "Print da primeira tela:" },
          { type: "image", url: "https://media.example/fold.png" },
        ],
        maxTokens: 500,
      },
      (u) => usage.push(u),
    );
    expect(text).toBe("{}");
    expect(calls).toEqual(["key_1/text-model"]);
    expect(requests[0]?.prompt[0]).toEqual({ role: "system", content: "sys" });
    const parts = requests[0]?.prompt[1]?.content as Array<{ type: string }>;
    expect(parts.map((p) => p.type)).toEqual(["text", "text", "file"]);
    expect(usage).toEqual([
      {
        provider: "openrouter",
        model: "text-model",
        promptTokens: 120,
        completionTokens: 30,
        costUsd: 0.0042,
      },
    ]);
  });

  it("a thinking call runs on smart when the org has no thinking model", async () => {
    const { ctx, calls } = contextWith({ text: "ok" });
    await orgLlm(ctx)({ tier: "thinking", systemPrompt: "s", userPrompt: "u" });
    expect(calls).toEqual(["key_1/text-model"]);
  });

  it("a cut answer fails, after reporting the tokens it billed", async () => {
    const { ctx } = contextWith({ text: '{"a":', finish: "length" });
    const usage: LlmUsage[] = [];
    await expect(
      orgLlm(ctx)(
        { tier: "smart", systemPrompt: "s", userPrompt: "u", maxTokens: 10 },
        (u) => usage.push(u),
      ),
    ).rejects.toBeInstanceOf(LlmTruncatedError);
    expect(usage).toHaveLength(1);
    expect(usage[0]?.costUsd).toBeUndefined();
  });

  it("an empty answer fails", async () => {
    const { ctx } = contextWith({ text: "" });
    await expect(
      orgLlm(ctx)({ tier: "smart", systemPrompt: "s", userPrompt: "u" }),
    ).rejects.toThrow("resposta vazia");
  });
});

/** An org with no provider key, so no tier resolves. */
function noProviderContext(): StudioContext {
  const base = chatToolContext();
  return chatToolContext({
    storage: { ...base.storage, aiProviderKeys: { list: async () => [] } },
  });
}

describe("an org without an AI model", () => {
  it("a call fails with the engine's message, not the tier error", async () => {
    const call = orgLlm(noProviderContext())({
      tier: "smart",
      systemPrompt: "s",
      userPrompt: "u",
    });
    await expect(call).rejects.toBeInstanceOf(NoAiModelError);
    await expect(call).rejects.toThrow(NO_AI_MODEL);
  });

  it("a thinking call with no smart to fall back on fails the same way", async () => {
    await expect(
      orgLlm(noProviderContext())({
        tier: "thinking",
        systemPrompt: "s",
        userPrompt: "u",
      }),
    ).rejects.toBeInstanceOf(NoAiModelError);
  });

  it("hasEngineModel says whether the smart tier resolves", async () => {
    expect(await hasEngineModel(chatToolContext())).toBe(true);
    expect(await hasEngineModel(noProviderContext())).toBe(false);
  });

  it("hasEngineModel lets a failure other than a missing model through", async () => {
    const base = chatToolContext();
    const broken = chatToolContext({
      storage: {
        ...base.storage,
        organizationSettings: {
          get: async () => {
            throw new Error("db down");
          },
        },
      },
    });
    await expect(hasEngineModel(broken)).rejects.toThrow("db down");
  });
});
