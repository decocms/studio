import { describe, expect, test } from "bun:test";
import {
  evaluateDiagnosis,
  evaluateGeneration,
  isLossTitle,
  repeatedRefutedCauses,
  type StoredDiagnosis,
  sumReports,
} from "./eval.ts";
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
// F3 = "add_to_cart: 5000 (10.0% de view_item)" on mobile.
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

describe("the yardstick of a stored diagnosis", () => {
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
            category: "ux",
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

  test("opportunity: comparison and a title that looks like a cause", () => {
    expect(report.opportunities.total).toBe(3);
    expect(report.opportunities.with_comparison).toBe(1);
    // The two a person would read as a cause: the card and the pop-up.
    expect(report.opportunities.cause_like_titles).toEqual([
      "Numa página 100% de promoção, o card não mostra desconto",
      "O pop-up de newsletter aparece na PDP",
    ]);
    // What today's code would build from the same evidence.
    expect(report.opportunities.today.titles).toEqual([
      "No celular, 10% de quem vê um produto põe no carrinho; no computador, 20%",
    ]);
  });

  test("hypothesis: cited fact, supported 'fato', states", () => {
    expect(report.hypotheses).toEqual({
      total: 3,
      with_cited_facts: 1,
      fact_claims: 2,
      fact_claims_grounded: 1,
      categories: { ux: 1, sem_categoria: 2 },
      refuted: 1,
      inconclusive: 0,
      blocked: 0,
      ready: 1,
    });
    expect(report.minutes).toBe(7);
  });

  test("human verdicts: a rejection that stood disagrees; an acceptance that stood agrees", () => {
    expect(report.labels.disagree).toEqual([
      "filtro e ordenação (derrubada: sem relação com a oportunidade)",
    ]);
    expect(report.labels.agree).toEqual(["pronta (aceita: ok)"]);
    expect(sumReports([report, report]).labels_disagree).toBe(2);
    expect(sumReports([report, report]).categories).toEqual({
      ux: 2,
      sem_categoria: 4,
    });
  });
});

describe("isLossTitle", () => {
  test("a measured loss has a number and the screen (or the audience)", () => {
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

describe("a replayed hypotheses step", () => {
  test("counts what stood, what fell and the opportunities left empty", () => {
    const report = evaluateGeneration(
      {
        byOpportunity: new Map([
          [
            "d:o1",
            [
              {
                title: "a",
                tree: { category: "trafego", a_favor: [], contra: [] },
              } as never,
            ],
          ],
          ["d:o2", []],
        ]),
        dropped: ["x: derrubada pelo crítico", "y: sem fato a favor"],
        droppedBy: new Map(),
      },
      ["d:o1", "d:o2", "d:o3"],
      evidence,
    );
    expect(report).toEqual({
      total: 1,
      with_cited_facts: 0,
      fact_claims: 0,
      fact_claims_grounded: 0,
      categories: { trafego: 1 },
      dropped: 2,
      empty_opportunities: 2,
    });
  });
});

describe("causes an earlier round already refuted", () => {
  const tree = (part: string) =>
    ({
      category: "ux",
      alvo: { kind: "part", key: part, label: part },
      metrica: { key: "produto_carrinho" },
      a_favor: [],
      contra: [],
    }) as never;
  const round = (
    id: string,
    started_at: string,
    hypotheses: Array<Partial<UxHypothesis>>,
    domain = "loja.example",
  ): StoredDiagnosis => ({
    diagnosis: { id, domain, page_type: "pdp", started_at },
    hypotheses: hypotheses.map((h) => hyp(h)),
  });

  test("a cause refuted before and proposed again is a repeat, whatever the order given", () => {
    const first = round("r1", "2026-11-01T00:00:00Z", [
      { title: "Tamanho escondido", tree: tree("size"), lifecycle: "refutada" },
      { title: "Frete tarde", tree: tree("shipping"), lifecycle: "gerada" },
    ]);
    const second = round("r2", "2026-11-08T00:00:00Z", [
      { title: "O tamanho some", tree: tree("size") },
      { title: "Frete aparece tarde", tree: tree("shipping") },
    ]);
    expect(repeatedRefutedCauses([second, first])).toEqual([
      { diagnosis_id: "r2", title: "O tamanho some", refuted_in: "r1" },
    ]);
  });

  test("another store, or a cause refuted in the same round, is not a repeat", () => {
    const first = round(
      "r1",
      "2026-11-01T00:00:00Z",
      [{ title: "a", tree: tree("size"), lifecycle: "refutada" }],
      "outra.example",
    );
    const second = round("r2", "2026-11-08T00:00:00Z", [
      { title: "b", tree: tree("size"), lifecycle: "refutada" },
    ]);
    expect(repeatedRefutedCauses([first, second])).toEqual([]);
  });
});
