import { describe, expect, test } from "bun:test";
import { evaluateDiagnosis, isLossTitle, sumReports } from "./eval.ts";
import { buildFacts } from "./facts.ts";
import { evidence as makeEvidence } from "./fixtures/evidence.ts";
import type { UxHypothesis, UxOpportunity } from "./types.ts";

const evidence = makeEvidence({
  revenue: {
    window_days: 28,
    currency: "BRL",
    by_channel: [
      {
        channel: "Principal (1)",
        orders: 100,
        revenue: 30_000,
        avg_ticket: 300,
      },
    ],
  },
});
const facts = buildFacts(evidence);
// F3 = "add_to_cart: 5000 (10.0% de view_item)" no celular.
const cart = facts.find((f) => f.text.startsWith("add_to_cart: 5000"));

const opp = (
  title: string,
  control?: "dispositivo" | "absoluta",
): UxOpportunity =>
  ({
    id: `d:${title}`,
    title,
    metric: control ? { key: "produto_carrinho", control } : null,
  }) as UxOpportunity;
const hyp = (over: Partial<UxHypothesis>): UxHypothesis =>
  ({
    id: "d:o1:h1",
    kind: "proposta",
    opportunity_id: "d:o1",
    title: "O tamanho cai abaixo da 1ª tela",
    lifecycle: "gerada",
    status: "pending",
    tree: { a_favor: [], contra: [] },
    ...over,
  }) as UxHypothesis;

describe("a régua de um diagnóstico gravado", () => {
  const report = evaluateDiagnosis(
    {
      diagnosis: {
        id: "d-categoria-x",
        page_type: "pdp",
        cost_usd: 1.5,
        started_at: "2026-11-16T19:37:00Z",
        finished_at: "2026-11-16T19:44:00Z",
        evidence: { ...evidence, facts },
      },
      opportunities: [
        opp(
          "No celular, 10% de quem vê um produto põe no carrinho; no computador, 20%",
          "dispositivo",
        ),
        opp(
          "Numa página 100% de promoção, o card não mostra desconto",
          "absoluta",
        ),
        opp("O pop-up de newsletter aparece na PDP"),
      ],
      hypotheses: [
        hyp({
          title: "O filtro e ordenação não fica fixo ao rolar",
          lifecycle: "relevancia_avaliada",
          tree: {
            a_favor: [
              {
                text: "10% põem no carrinho",
                label: "fato_observado",
                facts: [cart?.id ?? ""],
              },
              { text: "o filtro some ao rolar", label: "fato_observado" },
            ],
            contra: [],
          } as never,
        }),
        hyp({ id: "d:o1:h2", title: "outra", lifecycle: "refutada" }),
        hyp({
          id: "d:o1:h3",
          title: "pronta",
          lifecycle: "pronta_para_experimento",
        }),
      ],
    },
    [
      {
        diagnosis: "d-categoria",
        match: "filtro e ordenação",
        verdict: "derrubada",
        motivo: "sem relação com a oportunidade",
      },
      {
        diagnosis: "d-categoria",
        match: "pronta",
        verdict: "aceita",
        motivo: "ok",
      },
    ],
  );

  test("oportunidade: comparação e título que parece causa", () => {
    expect(report.opportunities.total).toBe(3);
    expect(report.opportunities.with_comparison).toBe(1);
    // As duas que a pessoa leria como causa: o card (categoria de uma
    // loja de moda) e o pop-up (o exemplo da revisão, 19/11).
    expect(report.opportunities.cause_like_titles).toEqual([
      "Numa página 100% de promoção, o card não mostra desconto",
      "O pop-up de newsletter aparece na PDP",
    ]);
    // O que o código de hoje montaria com a mesma evidência.
    expect(report.opportunities.today.titles).toEqual([
      "No celular, 10% de quem vê um produto põe no carrinho; no computador, 20%",
    ]);
  });

  test("hipótese: fato citado, 'fato' sustentado, estados", () => {
    expect(report.hypotheses).toEqual({
      total: 3,
      with_cited_facts: 1,
      fact_claims: 2,
      fact_claims_grounded: 1,
      refuted: 1,
      inconclusive: 0,
      blocked: 0,
      ready: 1,
    });
    expect(report.minutes).toBe(7);
  });

  test("vereditos humanos: derrubada que ficou de pé discorda; aceita de pé concorda", () => {
    expect(report.labels.disagree).toEqual([
      "filtro e ordenação (derrubada: sem relação com a oportunidade)",
    ]);
    expect(report.labels.agree).toEqual(["pronta (aceita: ok)"]);
    expect(sumReports([report, report]).labels_disagree).toBe(2);
  });
});

describe("isLossTitle", () => {
  test("perda medida tem número e a tela (ou o público)", () => {
    expect(
      isLossTitle(
        "Social pago no celular: 4,1% de quem vê um produto põe no carrinho, contra 17,5%",
      ),
    ).toBe(true);
    expect(
      isLossTitle("O card não mostra desconto numa página 100% promoção"),
    ).toBe(false);
    expect(
      isLossTitle("A busca no celular converte muito menos que no desktop"),
    ).toBe(false);
  });
});
