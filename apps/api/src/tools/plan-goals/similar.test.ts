import { describe, expect, it } from "bun:test";
import { MockLanguageModelV4 } from "ai/test";
import {
  acceptSameGoals,
  askSameGoals,
  buildSameGoalPrompt,
  goalTokens,
  MAX_SIMILAR_CANDIDATES,
  normalizeGoalStatement,
  prefilterSimilarGoals,
  tokenOverlap,
} from "./similar";

/**
 * The pure halves of the "same goal?" check, and the one model call against
 * the AI SDK's own mock model. The tool around them is not exercised here:
 * that would mean stubbing our own storage (see TESTING.md).
 */

const goal = (id: string, statement: string) => ({ id, statement });

function answering(text: string, delayMs = 0) {
  return new MockLanguageModelV4({
    doGenerate: async ({ abortSignal }) => {
      if (delayMs) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          abortSignal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(abortSignal.reason);
          });
        });
      }
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
}

describe("normalizeGoalStatement", () => {
  it("ignores case, accents, punctuation and spacing", () => {
    expect(normalizeGoalStatement("  Aumentar a CONVERSÃO   do app! ")).toBe(
      "aumentar a conversao do app",
    );
    expect(normalizeGoalStatement("Grow online revenue 30% in 2027.")).toBe(
      normalizeGoalStatement("grow online-revenue 30 % in 2027"),
    );
  });

  it("leaves nothing of a sentence with no letters or numbers", () => {
    expect(normalizeGoalStatement(" ?!… ")).toBe("");
  });
});

describe("goalTokens", () => {
  it("drops stop words and short words but keeps numbers", () => {
    expect([...goalTokens("Cut our return rate to 5% in 2027")]).toEqual([
      "cut",
      "return",
      "rate",
      "5",
      "2027",
    ]);
    expect([...goalTokens("Reduzir as trocas da nossa loja")]).toEqual([
      "reduzir",
      "trocas",
      "loja",
    ]);
  });

  it("overlaps by Jaccard, zero when either side is empty", () => {
    expect(tokenOverlap(new Set(["a", "b"]), new Set(["b", "c"]))).toBe(1 / 3);
    expect(tokenOverlap(new Set(), new Set(["a"]))).toBe(0);
  });
});

describe("prefilterSimilarGoals", () => {
  const goals = [
    goal("g1", "Make the app our main sales channel in 2027"),
    goal("g2", "Cut the return rate on apparel below 12%"),
    goal("g3", "make the APP our main sales channel in 2027!"),
    goal("g4", "Turn the app into our main sales channel"),
    goal("g5", "Lower CAC on paid social"),
  ];

  it("separates the same sentence from look-alikes, best overlap first", () => {
    const { exact, candidates } = prefilterSimilarGoals(
      "Make the app our main sales channel in 2027.",
      goals,
    );
    expect(exact.map((g) => g.id)).toEqual(["g1", "g3"]);
    expect(candidates.map((g) => g.id)).toEqual(["g4"]);
  });

  it("offers nothing that shares no word", () => {
    expect(prefilterSimilarGoals("Hire two designers", goals)).toEqual({
      exact: [],
      candidates: [],
    });
  });

  it("caps the candidates and keeps the given order between equals", () => {
    const many = Array.from({ length: MAX_SIMILAR_CANDIDATES + 3 }, (_, i) =>
      goal(`g${i}`, `Grow revenue in region ${i}`),
    );
    const { candidates } = prefilterSimilarGoals("Grow revenue", many);
    expect(candidates.map((g) => g.id)).toEqual(
      many.slice(0, MAX_SIMILAR_CANDIDATES).map((g) => g.id),
    );
  });

  it("matches nothing exactly when the sentence normalizes to nothing", () => {
    const { exact } = prefilterSimilarGoals("!!!", [goal("g1", "???")]);
    expect(exact).toEqual([]);
  });

  it("works on an org with no goals", () => {
    expect(prefilterSimilarGoals("Anything", [])).toEqual({
      exact: [],
      candidates: [],
    });
  });
});

describe("acceptSameGoals", () => {
  it("says yes only to offered pairs answered true and never false", () => {
    expect(
      acceptSameGoals(
        {
          answers: [
            { pair: 1, same: true },
            { pair: 2, same: false },
            { pair: 3, same: true },
            { pair: 3, same: false },
            { pair: 9, same: true },
            { pair: 0, same: true },
          ],
        },
        4,
      ),
    ).toEqual([true, false, false, false]);
  });

  it("reads a missing answer as all no", () => {
    expect(acceptSameGoals(null, 2)).toEqual([false, false]);
  });
});

describe("askSameGoals", () => {
  const pairs = [
    { a: "Grow app sales", b: "Make the app our main channel" },
    { a: "Grow app sales", b: "Grow   app\nsales fast" },
  ];

  it("numbers the pairs and flattens their whitespace", () => {
    expect(buildSameGoalPrompt(pairs)).toBe(
      "Pair 1:\nA: Grow app sales\nB: Make the app our main channel\n\nPair 2:\nA: Grow app sales\nB: Grow app sales fast",
    );
  });

  it("reads the model's verdict, even wrapped in prose", async () => {
    const model = answering(
      'Here you go: {"answers":[{"pair":1,"same":false},{"pair":2,"same":true}]}',
    );
    expect(
      await askSameGoals(model, pairs, AbortSignal.timeout(1_000)),
    ).toEqual([false, true]);
  });

  it("reads an answer that does not parse as all no", async () => {
    expect(
      await askSameGoals(
        answering("yes, both"),
        pairs,
        AbortSignal.timeout(1_000),
      ),
    ).toEqual([false, false]);
  });

  it("gives up at the deadline", async () => {
    const model = answering('{"answers":[{"pair":1,"same":true}]}', 5_000);
    const started = Date.now();
    await expect(
      askSameGoals(model, pairs, AbortSignal.timeout(50)),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("asks nothing for no pairs", async () => {
    const model = answering("{}");
    expect(await askSameGoals(model, [], AbortSignal.timeout(1_000))).toEqual(
      [],
    );
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});
