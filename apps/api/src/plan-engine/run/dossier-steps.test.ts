import { describe, expect, test } from "bun:test";
import type { HypothesisRelevance } from "../relevance.ts";
import type { UxHypothesis, UxOpportunity } from "../types.ts";
import { evidence, sampleFunnel } from "../fixtures/evidence.ts";
import {
  afterRelevance,
  applyReview,
  MOCKUP_OFF,
  mockupGapIds,
  needsRelevance,
  planFor,
} from "./dossier-steps.ts";

const h = (lifecycle: UxHypothesis["lifecycle"]) =>
  ({
    lifecycle,
    lifecycle_log: [],
    verification: null,
  }) as unknown as UxHypothesis;
const r = (level: HypothesisRelevance["level"]) =>
  ({ level, affected_pct: 80, affected_week: 9_000 }) as HypothesisRelevance;

describe("afterRelevance", () => {
  test("condition confirmed → relevance evaluated, and the level goes into validation", () => {
    const out = afterRelevance(h("condicao_confirmada"), r("alta"), "t");
    expect(out?.lifecycle).toBe("relevancia_avaliada");
    expect(out?.validation.relevancia).toBe("alta");
    expect(out?.lifecycle_log[0]?.reason).toContain("80%");
  });

  test("few people → no relevance; without a confirmed condition it does not move", () => {
    expect(
      afterRelevance(h("condicao_confirmada"), r("sem_relevancia"), "t")
        ?.lifecycle,
    ).toBe("sem_relevancia");
    expect(afterRelevance(h("gerada"), r("alta"), "t")).toBeNull();
  });

  test("only confirmed-condition (or already evaluated) ones count", () => {
    expect(needsRelevance(h("condicao_confirmada"))).toBe(true);
    expect(needsRelevance(h("relevancia_avaliada"))).toBe(true);
    expect(needsRelevance(h("inconclusiva"))).toBe(false);
  });
});

describe("planFor", () => {
  test("evaluated relevance + measurable + reliable data → ready for the test", async () => {
    const hyp = {
      lifecycle: "relevancia_avaliada",
      lifecycle_log: [],
      verification: null,
      device: "mobile",
      title: "t",
      idea: "barra fixa",
      after_url: null,
      tree: {
        metrica: {
          key: "produto_carrinho",
          direcao: "sobe",
          efeito_esperado_pp: 1,
        },
        a_favor: [],
        contra: [],
        fontes_conhecimento: [],
        esforco: 1,
        testavel_na_pagina: true,
      },
      relevance: { level: "alta", affected_pct: 100 },
    } as unknown as UxHypothesis;
    const opp = {
      area: "tamanho",
      metric: null,
      money: null,
      reliability: { level: "alta", checks: [] },
    } as never;
    const plan = planFor(
      hyp,
      opp,
      evidence({ platform_funnel: sampleFunnel }),
      new Map(),
      1,
      "t",
    );
    expect(plan.lifecycle?.lifecycle).toBe("pronta_para_experimento");
    expect(plan.experiment?.weeks).toBe(2);
    expect(plan.priority.teste).not.toBeNull();

    const low = planFor(
      { ...hyp, relevance: { level: "baixa", affected_pct: 10 } } as never,
      opp,
      evidence({ platform_funnel: sampleFunnel }),
      new Map(),
      1,
      "t",
    );
    expect(low.lifecycle).toBeUndefined();
    expect(low.priority.teste).toBeNull();
  });
});

describe("applyReview", () => {
  const ready = {
    lifecycle: "pronta_para_experimento",
    lifecycle_log: [],
    verification: null,
    priority: { teste: 0.5, investigacao: 0.1 },
  } as unknown as UxHypothesis;
  const review = (explica_o_gap: "sim" | "parcial" | "nao") => ({
    explica_o_gap,
    resposta: "r",
    falhas: [],
    reviewed_at: "t",
  });

  test("does not explain: leaves ready and loses the test priority", async () => {
    const out = applyReview(ready, review("nao"), "t");
    expect(out.lifecycle?.lifecycle).toBe("relevancia_avaliada");
    expect(out.priority?.teste).toBeNull();
  });

  test("parcial cuts 20%; sim keeps it; never promotes", async () => {
    expect(applyReview(ready, review("parcial"), "t").priority?.teste).toBe(
      0.4,
    );
    const yes = applyReview(ready, review("sim"), "t");
    expect(yes.priority?.teste).toBe(0.5);
    expect(yes.lifecycle).toBeUndefined();
  });
});

describe("mockup off", () => {
  const opp = (rank: number) =>
    ({ id: `o${rank}`, rank, outcome: null }) as unknown as UxOpportunity;
  const prop = (
    id: string,
    lifecycle: UxHypothesis["lifecycle"],
    over: Partial<UxHypothesis> = {},
  ) =>
    ({
      id,
      opportunity_id: "o1",
      rank: 1,
      kind: "proposta",
      lifecycle,
      lifecycle_log: [],
      verification: null,
      after_url: null,
      after_patch: null,
      mockup_error: null,
      ...over,
    }) as unknown as UxHypothesis;

  test("only ready ones with no After and no reason get the gap", async () => {
    expect(MOCKUP_OFF).toBe("mockup desligado");
    const ids = mockupGapIds(
      [opp(1)],
      [
        prop("pronta", "pronta_para_experimento"),
        prop("avaliada", "relevancia_avaliada"),
        prop("ja-marcada", "pronta_para_experimento", {
          mockup_error: MOCKUP_OFF,
        }),
        prop("com-depois", "pronta_para_experimento", {
          after_url: "https://loja.example/depois.png",
        }),
        prop("nao-faria", "pronta_para_experimento", { kind: "nao_faria" }),
      ],
    );
    expect(ids).toEqual(["pronta"]);
  });

  test("with no live opportunity there is nothing to mark", async () => {
    expect(
      mockupGapIds([], [prop("pronta", "pronta_para_experimento")]),
    ).toEqual([]);
  });
});
