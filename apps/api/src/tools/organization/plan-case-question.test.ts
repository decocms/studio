import { describe, expect, it, mock } from "bun:test";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { PLAN_CASE_NEXT_QUESTION } from "./plan-case-question";

type Ctx = Parameters<typeof PLAN_CASE_NEXT_QUESTION.handler>[1];

function makeCtx(
  modelOutput: unknown,
  flags: Record<string, unknown> | null = { plan_page_enabled: true },
) {
  const requests: LanguageModelV4CallOptions[] = [];
  const models: string[] = [];
  const ctx = {
    auth: { user: { id: "user-1" } },
    organization: { id: "org-a", slug: "acme" },
    access: { check: mock(async () => {}), setToolName: () => {} },
    storage: {
      organizationSettings: {
        get: async () => ({
          ...(flags ? { flags } : {}),
          simple_mode: {
            tiers: {
              fast: { keyId: "key_1", modelId: "fast-model" },
              smart: { keyId: "key_1", modelId: "smart-model" },
            },
          },
        }),
      },
      aiProviderKeys: {
        list: async () => [{ id: "key_1", providerId: "openrouter" }],
      },
    },
    aiProviders: {
      listModels: async () => [],
      activate: async () => ({
        info: { id: "openrouter" },
        aiSdk: {
          languageModel: (modelId: string) => {
            models.push(modelId);
            return new MockLanguageModelV4({
              doGenerate: async (options) => {
                requests.push(options);
                return {
                  content: [
                    { type: "text", text: JSON.stringify(modelOutput) },
                  ],
                  finishReason: { unified: "stop", raw: "stop" },
                  usage: {
                    inputTokens: {
                      total: 10,
                      noCache: 10,
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
  } as unknown as Ctx;
  return { ctx, requests, models };
}

const ASKING = {
  reaction: "Boa, busca é um ótimo lugar para começar.",
  question: "O que mais te incomoda na busca?",
  options: [
    "Buscas que não acham nada",
    "Autocomplete fraco",
    "Filtros difíceis",
    "Ordem dos resultados",
    "Uma quinta opção que sobra",
  ],
  title: "Melhorar a busca",
};

describe("PLAN_CASE_NEXT_QUESTION", () => {
  it("refuses unless the Plan page is on", async () => {
    for (const flags of [null, {}, { plan_page_enabled: false }]) {
      const { ctx, models } = makeCtx(ASKING, flags);
      await expect(
        PLAN_CASE_NEXT_QUESTION.handler({ idea: "busca", answers: [] }, ctx),
      ).rejects.toThrow(/not enabled/);
      expect(models).toEqual([]);
    }
  });

  it("asks on the fast tier, without a reaction on the first step", async () => {
    const { ctx, models, requests } = makeCtx(ASKING);
    const result = await PLAN_CASE_NEXT_QUESTION.handler(
      { idea: "Quero mexer na busca", objective: null, answers: [] },
      ctx,
    );
    expect(models).toEqual(["fast-model"]);
    expect(JSON.stringify(requests[0]?.prompt)).toContain(
      "Quero mexer na busca",
    );
    expect(result.reaction).toBeNull();
    expect(result.question?.text).toBe(ASKING.question);
    expect(result.question?.options).toHaveLength(4);
    expect(result.title).toBe("Melhorar a busca");
  });

  it("reacts to the last answer and passes skipped answers along", async () => {
    const { ctx, requests } = makeCtx(ASKING);
    const result = await PLAN_CASE_NEXT_QUESTION.handler(
      {
        idea: "Quero mexer na busca",
        answers: [
          { question: "Em qual dispositivo?", answer: "" },
          { question: "O que te incomoda?", answer: "Buscas vazias" },
        ],
      },
      ctx,
    );
    expect(result.reaction).toBe(ASKING.reaction);
    const prompt = JSON.stringify(requests[0]?.prompt);
    expect(prompt).toContain("(skipped)");
    expect(prompt).toContain("Buscas vazias");
  });

  it("returns no question when the model has enough", async () => {
    const { ctx } = makeCtx({
      reaction: "",
      question: "  ",
      options: ["leftover"],
      title: "",
    });
    const result = await PLAN_CASE_NEXT_QUESTION.handler(
      {
        idea: "Um guia de medidas na página de produto, no celular",
        answers: [],
      },
      ctx,
    );
    expect(result).toEqual({ reaction: null, question: null, title: null });
  });

  it("stops after five answers without calling a model", async () => {
    const { ctx, models } = makeCtx(ASKING);
    const answers = Array.from({ length: 5 }, (_, i) => ({
      question: `Pergunta ${i}`,
      answer: "Resposta",
    }));
    const result = await PLAN_CASE_NEXT_QUESTION.handler(
      { idea: "busca", answers },
      ctx,
    );
    expect(result.question).toBeNull();
    expect(models).toEqual([]);
  });

  it("rejects empty and oversized input", () => {
    const schema = PLAN_CASE_NEXT_QUESTION.inputSchema;
    expect(schema.safeParse({ idea: "  ", answers: [] }).success).toBe(false);
    expect(
      schema.safeParse({ idea: "x".repeat(601), answers: [] }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        idea: "busca",
        answers: Array.from({ length: 6 }, () => ({
          question: "q",
          answer: "a",
        })),
      }).success,
    ).toBe(false);
  });
});
