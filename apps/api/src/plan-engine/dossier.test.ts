import { describe, expect, test } from "bun:test";
import { buildDossier, conclusionOf } from "./dossier.ts";
import type { UxHypothesis, UxOpportunity } from "./types.ts";

const h = {
  id: "d:o1:h1",
  diagnosis_id: "d",
  opportunity_id: "d:o1",
  title: "O tamanho fica abaixo da dobra",
  why: "a pessoa precisa rolar",
  lifecycle: "pronta_para_experimento",
  lifecycle_log: [],
  verification: {
    verdict: "confirmada",
    summary: "c1 confirmou",
    runs: [
      {
        check: { id: "c1", claim: "seletor abaixo da dobra", stage: "live" },
        outcome: "confirma",
        observed: "inspect: y=1272 (tela 844)",
        screenshot_url: null,
        source_ref: null,
      },
      {
        check: { id: "c2", claim: "outra coisa", stage: "repo" },
        outcome: "confirma",
        observed: "x",
        screenshot_url: null,
        source_ref: null,
        measures_cause: false,
      },
    ],
    rewritten_from: null,
    verified_at: "t",
  },
  validation: {
    existencia: "confirmada",
    implementacao: "nao_testada",
    relevancia: "alta",
    causal: "nao_testado",
  },
  tree: {
    category: "ux",
    statement:
      "Se a barra ficar fixa, então viu → carrinho sobe, porque não precisa rolar.",
    a_favor: [{ text: "seletor em y=1272", label: "fato_observado" }],
    contra: [{ text: "o gap aparece também na busca", label: "inferencia" }],
    segmento: "celular",
    metrica: {
      key: "produto_carrinho",
      direcao: "sobe",
      efeito_esperado_pp: 1,
    },
  },
  relevance: { affected_week: 1_408_850, affected_pct: 100, signals: [] },
  experiment: {
    controle: "A PDP como está",
    variante: "Barra fixa",
    metrica_primaria: { label: "viu produto → carrinho", device: "mobile" },
    secundarias: [],
    guardrails: ["receita por visitante"],
    metodo: "A/B 50/50",
    baseline: 0.1042,
    n_per_group: 15_274,
    weeks: 2,
    weekly_eligible: 406_498,
    mde_pp: 1,
    measurable: true,
  },
} as unknown as UxHypothesis;

const o = {
  title: "Estamos perdendo carrinho no celular",
  measured: {
    label: "viu produto → carrinho",
    device: "mobile",
    rate: 0.104,
    n: 406_498,
    comp: { device: "desktop", rate: 0.234 },
  },
  drilldown: {
    gap_pp: 9.07,
    mix_adjusted_gap_pp: { canal: 8.1 },
    consistency: { canal: { same: 6, total: 7 } },
  },
  reliability: {
    level: "media",
    checks: [
      { severity: "atencao", label: "Tracking", text: "fontes divergem" },
    ],
  },
} as unknown as UxOpportunity;

describe("buildDossier", () => {
  const md = buildDossier({ hypothesis: h, opportunity: o });

  test("the round's goal enters as one line, only when it exists", () => {
    const withGoal = buildDossier({
      hypothesis: h,
      opportunity: o,
      objective: "Vender mais vestidos",
    });
    expect(withGoal).toContain("**Meta da rodada:** Vender mais vestidos");
    expect(
      withGoal.replace("**Meta da rodada:** Vender mais vestidos\n\n", ""),
    ).toBe(md);
    expect(md).not.toContain("Meta da rodada");
    expect(
      buildDossier({ hypothesis: h, opportunity: o, objective: " " }),
    ).toBe(md);
  });

  test("the six parts, in text order", () => {
    const order = [
      "## Problema relacionado",
      "## 1. Hipótese",
      "## 2. Evidências encontradas",
      "## 3. Evidências contrárias e limitações",
      "## 4. Validações",
      "## 5. Experimento recomendado",
      "## Conclusão",
    ].map((t) => md.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("the cuts and the relevance basis go in, so the reviewer does not invent an explanation", () => {
    expect(md).toContain(
      "Recortes do GA4: com a mistura de canais do outro dispositivo o gap vai de 9.07 para 8.1 pp; o gap aparece em 6 de 7 canais",
    );
  });

  test("each claim with its type; a test outside the cause does not count as evidence", () => {
    expect(md).toContain("seletor em y=1272 _(fato)_");
    expect(md).toContain("o gap aparece também na busca _(inferência)_");
    expect(md).toContain("seletor abaixo da dobra");
    expect(md).not.toContain("outra coisa");
    expect(md).toContain("Tracking: fontes divergem");
  });

  test("causal effect is always untested, and the conclusion does not promise conversion", () => {
    expect(md).toContain("Efeito causal: Não testado");
    expect(md).toContain("15.274 por grupo, 2 semana(s)");
    expect(conclusionOf(h)).toContain(
      "ainda não há evidência de que a mudança aumenta a conversão",
    );
  });

  test("with the review, failures become a limitation and the review appears", () => {
    const reviewed = buildDossier({
      hypothesis: h,
      opportunity: o,
      review: {
        explica_o_gap: "parcial",
        resposta: "plausível, sem dado da loja ligando à perda",
        falhas: ["condição tratada como causa"],
        reviewed_at: "t",
      },
    });
    expect(reviewed).toContain("- Revisor: condição tratada como causa");
    expect(reviewed).toContain("Explica o gap? parcial.");
  });

  // The reviewer reads the data the claim cites, not just the sentence.
  test("with the fact book, each claim carries the cited data", () => {
    const withFacts = buildDossier({
      hypothesis: {
        ...h,
        tree: {
          ...h.tree,
          a_favor: [
            {
              text: "seletor em y=1272",
              label: "fato_observado",
              facts: ["F7"],
            },
          ],
        },
      } as UxHypothesis,
      opportunity: o,
      facts: [
        {
          id: "F7",
          kind: "posicao",
          source: "pagina",
          device: "mobile",
          measured: true,
          group: "g",
          text: "seletor de tamanho: y=1272px, abaixo da 1ª tela (844px): 428px de rolagem",
        },
      ],
    });
    expect(withFacts).toContain(
      "- seletor em y=1272 _(fato)_\n  - dado: página real, celular: seletor de tamanho: y=1272px, abaixo da 1ª tela (844px): 428px de rolagem",
    );
  });
});
