import { describe, expect, test } from "bun:test";
import {
  designExperiment,
  detectableEffect,
  sampleSizePerGroup,
} from "./experiment.ts";
import { evidence, sampleFunnel } from "./fixtures/evidence.ts";
import type { HypothesisRelevance } from "./relevance.ts";
import type { HypothesisTree } from "./tree.ts";

describe("sampleSizePerGroup", () => {
  test("10% -> 11%, two-tailed α 5%, power 80%: 14,751 per group", () => {
    expect(sampleSizePerGroup(0.1, 0.11)).toBe(14_751);
  });

  test("no difference or rate outside (0,1): infinite", () => {
    expect(sampleSizePerGroup(0.1, 0.1)).toBe(Number.POSITIVE_INFINITY);
    expect(sampleSizePerGroup(0, 0.1)).toBe(Number.POSITIVE_INFINITY);
  });

  test("the detectable effect is the inverse of the sample", () => {
    expect(detectableEffect(0.1, 14_751)).toBeCloseTo(0.01, 4);
    expect(detectableEffect(0.1, 0)).toBeNull();
  });
});

const tree = (over: Partial<HypothesisTree["metrica"]> = {}) =>
  ({
    causa: "O tamanho fica abaixo da dobra",
    category: "ux",
    metrica: {
      key: "produto_carrinho",
      direcao: "sobe",
      efeito_esperado_pp: 1,
      ...over,
    },
  }) as HypothesisTree;

const sample = evidence({ platform_funnel: sampleFunnel });
const relevance = (affected_pct: number) =>
  ({ affected_pct, level: "alta" }) as HypothesisRelevance;

describe("designExperiment (fashion store, viewed -> cart on mobile 10.4%)", () => {
  const h = {
    title: "t",
    idea: "Barra fixa com tamanho",
    device: "mobile" as const,
    tree: tree(),
    after_url: null,
  };
  const o = { area: "tamanho" as const, metric: null };

  test("1 pp effect with every view: fits the 2-week minimum", () => {
    const e = designExperiment({
      hypothesis: h,
      opportunity: o,
      evidence: sample,
      relevance: relevance(100),
    });
    expect(e?.baseline).toBeCloseTo(0.1042, 3);
    expect(e?.weekly_at_step).toBe(325_198);
    expect(e?.n_per_group).toBeGreaterThan(14_000);
    expect(e?.weeks).toBe(2);
    expect(e?.measurable).toBe(true);
    expect(e?.secundarias).toContain("toques no seletor de tamanho");
    expect(e?.guardrails).toContain("receita por visitante");
    expect(e?.metodo).not.toContain("exposição");
  });

  test("an effect too small becomes the 3% relative floor", () => {
    const e = designExperiment({
      hypothesis: { ...h, tree: tree({ efeito_esperado_pp: 0.01 }) },
      opportunity: o,
      evidence: sample,
      relevance: relevance(100),
    });
    // 3% of 10.4% = 0.31 pp.
    expect(e?.mde_pp).toBeCloseTo(0.31, 1);
  });

  test("almost nobody exposed: does not close in 8 weeks -> not measurable", () => {
    const e = designExperiment({
      hypothesis: { ...h, tree: tree({ efeito_esperado_pp: 0.3 }) },
      opportunity: o,
      evidence: sample,
      relevance: relevance(1),
    });
    expect(e?.measurable).toBe(false);
    expect(e?.metodo).toContain("exposição");
    expect(e?.limitacoes.join(" ")).toContain("não é mensurável agora");
  });

  test("no baseline: null", () => {
    expect(
      designExperiment({
        hypothesis: { ...h, tree: tree({ key: "checkout_compra" }) },
        opportunity: o,
        evidence: evidence({ platform_funnel: [] }),
        relevance: null,
      }),
    ).toBeNull();
  });
});
