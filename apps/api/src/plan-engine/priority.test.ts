import { describe, expect, test } from "bun:test";
import type { ExperimentDesign } from "./experiment.ts";
import { evidence } from "./fixtures/evidence.ts";
import { CURATED_KNOWLEDGE } from "./knowledge/curated.ts";
import type { KnowledgeEntry } from "./knowledge/types.ts";
import {
  CONFIDENCE_CEILING,
  isReady,
  priorityOf,
  queueOrder,
} from "./priority.ts";
import type { HypothesisRelevance } from "./relevance.ts";
import type { HypothesisTree } from "./tree.ts";

const ev = evidence();
const tree = (over: Partial<HypothesisTree> = {}) =>
  ({
    a_favor: [],
    contra: [],
    fontes_conhecimento: [],
    esforco: 2,
    testavel_na_pagina: true,
    ...over,
  }) as unknown as HypothesisTree;
const experiment = (weeks: number) =>
  ({ weeks, measurable: weeks <= 8 }) as ExperimentDesign;
const relevance = (level: HypothesisRelevance["level"], affected_pct = 100) =>
  ({ level, affected_pct }) as HypothesisRelevance;

const base = (over: Record<string, unknown> = {}) =>
  priorityOf({
    hypothesis: {
      tree: tree(),
      validation: null,
      device: "mobile",
      lifecycle: "gerada",
    },
    opportunity: {
      money: { monthly_value: 100_000 } as never,
      area: "tamanho",
    },
    relevance: relevance("alta"),
    experiment: experiment(2),
    evidence: ev,
    knowledge: new Map(),
    referenceValue: 1_000_000,
    ready: true,
    ...over,
  });

describe("priorityOf", () => {
  test("fato medido pesa mais que benchmark; contra derruba; teto de 0,9", () => {
    const fact = base({
      hypothesis: {
        tree: tree({ a_favor: [{ text: "x 1", label: "fato_observado" }] }),
        validation: null,
        device: "mobile",
      },
    });
    const bench = base({
      hypothesis: {
        tree: tree({ a_favor: [{ text: "x", label: "evidencia_indireta" }] }),
        validation: null,
        device: "mobile",
      },
    });
    expect(fact.confianca).toBeGreaterThan(bench.confianca);
    const against = base({
      hypothesis: {
        tree: tree({
          a_favor: [{ text: "x 1", label: "fato_observado" }],
          contra: [{ text: "y 2", label: "fato_observado" }],
        }),
        validation: null,
        device: "mobile",
      },
    });
    expect(against.confianca).toBeLessThan(fact.confianca);
    const max = base({
      hypothesis: {
        tree: tree({
          a_favor: Array.from({ length: 6 }, () => ({
            text: "1",
            label: "fato_observado" as const,
          })),
        }),
        validation: {
          existencia: "confirmada",
          implementacao: "confirmada",
          relevancia: "alta",
          causal: "nao_testado",
        },
        device: "mobile",
      },
    });
    expect(max.confianca).toBe(CONFIDENCE_CEILING);
  });

  test("A/B desta loja que perdeu na mesma parte: risco e conhecimento contra", () => {
    const lost: KnowledgeEntry = {
      ...CURATED_KNOWLEDGE[0]!,
      id: "ab1",
      tipo_fonte: "ab_desta_loja",
      resultado: "negativo",
      areas: ["tamanho"],
    };
    const p = base({
      hypothesis: {
        tree: tree({ fontes_conhecimento: ["ab1"] }),
        validation: null,
        device: "mobile",
      },
      knowledge: new Map([["ab1", lost]]),
    });
    expect(p.risco).toBe(0.5);
    expect(p.confianca).toBeLessThan(0.2);
  });

  test("a meta da rodada entra só nas notas; os números não mudam", () => {
    const without = base();
    const withGoal = base({ objective: "Vender mais vestidos" });
    const { notas: a, ...numbersA } = without;
    const { notas: b, ...numbersB } = withGoal;
    expect(numbersB).toEqual(numbersA);
    expect(b).toEqual(["meta da rodada: Vender mais vestidos", ...a]);
  });

  test("investigação sobe com a incerteza; teste só pra pronta", () => {
    const unsure = base();
    expect(unsure.investigacao).toBeGreaterThan(0);
    expect(base({ ready: false }).teste).toBeNull();
    // Mais de 8 semanas: mensurabilidade zero.
    expect(base({ experiment: experiment(12) }).teste).toBe(0);
  });
});

describe("isReady", () => {
  const o = { reliability: { level: "alta" as const, checks: [] } };
  test("relevante, mensurável e com dados confiáveis", () => {
    expect(
      isReady({
        relevance: relevance("media"),
        experiment: experiment(3),
        opportunity: o,
      }).ready,
    ).toBe(true);
    expect(
      isReady({
        relevance: relevance("baixa"),
        experiment: experiment(3),
        opportunity: o,
      }).ready,
    ).toBe(false);
    expect(
      isReady({
        relevance: relevance("alta"),
        experiment: experiment(12),
        opportunity: o,
      }).why,
    ).toContain("8 semanas");
    expect(
      isReady({
        relevance: relevance("alta"),
        experiment: experiment(3),
        opportunity: { reliability: { level: "baixa", checks: [] } },
      }).ready,
    ).toBe(false);
  });
});

describe("queueOrder", () => {
  test("pela prioridade de teste, e o valor da oportunidade só na primeira", () => {
    const money = { monthly_value: 500 } as never;
    const out = queueOrder([
      {
        id: "a",
        opportunity_id: "o1",
        money,
        priority: { teste: 0.2 } as never,
      },
      {
        id: "b",
        opportunity_id: "o1",
        money,
        priority: { teste: 0.6 } as never,
      },
      { id: "c", opportunity_id: "o2", money, priority: null },
    ]);
    expect(out.map((h) => [h.id, h.money !== null])).toEqual([
      ["b", true],
      ["a", false],
      ["c", true],
    ]);
  });
});
