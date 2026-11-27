import { describe, expect, test } from "bun:test";
import { evidence as makeEvidence } from "./fixtures/evidence.ts";
import { CURATED_KNOWLEDGE } from "./knowledge/curated.ts";
import { selectKnowledge } from "./knowledge/select.ts";
import {
  applyChallenge,
  fallenLimit,
  fallenReason,
  generateOpportunityHypotheses,
  hypothesesSystem,
  parseOpportunityHypotheses,
} from "./opportunities.ts";
import type { Llm, LlmRequest } from "./ports.ts";
import { crossRunKey } from "./triage.ts";
import type { DiagnosisEvidence, UxOpportunity } from "./types.ts";

const evidence: DiagnosisEvidence = {
  window_days: 7,
  platform_funnel: [
    {
      platform: "web_mobile",
      steps: [
        { event: "view_item", count: 1000 },
        { event: "add_to_cart", count: 111 },
      ],
    },
  ],
  pdp_behaviour: [],
  revenue: null,
  products: [],
  captures: [],
  benchmark: [
    {
      domain: "rival.example",
      url: "https://www.rival.example/br/x-p1.html",
      screenshot_url: null,
      full_url: null,
      anatomy: {
        sticky_buy: true,
        size_above_fold: true,
        price_above_fold: true,
        shipping_estimate: null,
        wishlist: true,
        recommendation_position: null,
        notes: "",
        by_area: { botao_compra: "barra fixa com tamanho e comprar" },
      },
      captured_at: "2026-11-09T00:00:00Z",
    },
  ],
  gaps: [{ source: "heatmap", error: "fora do ar" }],
};

describe("parseOpportunityHypotheses", () => {
  const opportunity: UxOpportunity = {
    id: "d:o1",
    diagnosis_id: "d",
    rank: 1,
    area: "botao_compra",
    title: "Perdemos conversão no celular",
    summary: "",
    device: "mobile",
    sources: [],
    money: null,
    confidence: 0.5,
    updated_at: "",
  };

  test("cited knowledge goes into the evidence; a label outside the block drops", () => {
    const block = selectKnowledge({
      entries: CURATED_KNOWLEDGE,
      areas: ["botao_compra"],
    });
    const label = [...block.byLabel.keys()][0];
    const raw = JSON.stringify({
      opportunities: [
        {
          rank: 1,
          hypotheses: [
            {
              title: "Botão longe",
              idea: "Barra fixa",
              why: "o botão fica sempre à mão",
              prediction: "o botão teria pouco alcance",
              check: "apoia",
              a_favor: [{ texto: "sinal", fatos: ["F3"], tipo: "inferencia" }],
              fontes_conhecimento: [label, "K99"],
            },
          ],
        },
      ],
    });
    const [h] =
      parseOpportunityHypotheses(
        raw,
        [opportunity],
        evidence,
        block,
      ).byOpportunity.get("d:o1") ?? [];
    if (!h || !label) throw new Error("expected a hypothesis and a label");
    const cited = block.byLabel.get(label);
    expect(h.evidence_md).toContain(
      `**Por que explicaria (o que já se sabe):**\n- ${cited?.conhecimento}`,
    );
    // The source's literal excerpt comes along so the citation can be checked.
    if (cited?.trecho) {
      expect(h.evidence_md).toContain(`> "${cited.trecho}"`);
    }
    expect(h.evidence_md.match(/o que já se sabe/gi)).toHaveLength(1);
  });

  test("only captured stores enter the benchmark (www or not); the rest is from memory and drops", () => {
    const raw = JSON.stringify({
      opportunities: [
        {
          rank: 1,
          hypotheses: [
            {
              title: "Botão longe",
              idea: "Barra fixa",
              why: "o botão fica sempre à mão",
              prediction: "o botão teria pouco alcance",
              check: "apoia",
              a_favor: [{ texto: "sinal", fatos: ["F3"], tipo: "inferencia" }],
              benchmark: [
                { domain: "www.rival.example", what_they_do: "barra fixa" },
                {
                  domain: "concorrente-exemplo.com.br",
                  what_they_do: "barra fixa",
                },
              ],
            },
          ],
        },
      ],
    });
    const [h] =
      parseOpportunityHypotheses(
        raw,
        [opportunity],
        evidence,
      ).byOpportunity.get("d:o1") ?? [];
    if (!h) throw new Error("expected a hypothesis");
    expect(h.benchmark).toEqual([
      {
        domain: "rival.example",
        url: "https://www.rival.example/br/x-p1.html",
        what_they_do: "barra fixa",
      },
    ]);
    expect(h.opportunity_id).toBe("d:o1");
    expect(h.device).toBe("mobile");
  });

  test("at most 3 hypotheses, and one without an intervention (outside traffic/commercial) is left out", () => {
    const hyp = (title: string) => ({
      title,
      idea: "faz",
      why: "porque sim",
      prediction: "x subiria",
      check: "apoia",
      a_favor: [{ texto: "sinal", fatos: ["F3"], tipo: "inferencia" }],
    });
    const raw = JSON.stringify({
      opportunities: [
        {
          rank: 1,
          hypotheses: [
            { title: "sem ideia" },
            hyp("a"),
            hyp("b"),
            hyp("c"),
            hyp("d"),
          ],
        },
        { rank: 9, hypotheses: [hyp("de outra")] },
      ],
    });
    const out = parseOpportunityHypotheses(
      raw,
      [opportunity],
      evidence,
    ).byOpportunity;
    expect([...out.keys()]).toEqual(["d:o1"]);
    expect(out.get("d:o1")?.map((h) => [h.rank, h.title])).toEqual([
      [1, "a"],
      [2, "b"],
      [3, "c"],
    ]);
  });

  describe("the hypothesis is a cause of the opportunity's loss", () => {
    const hyp = (title: string, extra: Record<string, unknown> = {}) => ({
      title,
      idea: "faz",
      why: "porque sim",
      prediction: "x subiria",
      check: "apoia",
      a_favor: [{ texto: "sinal", fatos: ["F3"], tipo: "inferencia" }],
      ...extra,
    });
    const withMetric = (
      control: "absoluta" | "dispositivo",
    ): UxOpportunity => ({
      ...opportunity,
      metric: {
        key: "pagina_produto",
        device: "mobile",
        compare_to: control === "dispositivo" ? "desktop" : null,
        control,
      },
    });
    const run = (o: UxOpportunity, hypotheses: unknown[]) =>
      parseOpportunityHypotheses(
        JSON.stringify({ opportunities: [{ rank: 1, hypotheses }] }),
        [o],
        evidence,
      );

    test("another step drops; the same step under another name stays; no step inherits the opportunity's", () => {
      const out = run(withMetric("absoluta"), [
        hyp("mexe no carrinho", { metrica: { key: "produto_carrinho" } }),
        hyp("clique na vitrine", { metrica: { key: "lista_produto" } }),
        hyp("sem etapa"),
      ]);
      const kept = out.byOpportunity.get("d:o1") ?? [];
      expect(kept.map((h) => h.title)).toEqual([
        "clique na vitrine",
        "sem etapa",
      ]);
      expect(kept.map((h) => h.tree?.metrica.key)).toEqual([
        "pagina_produto",
        "pagina_produto",
      ]);
      expect(out.dropped.join(" ")).toContain(
        "mexe em outra etapa — produto_carrinho — e a oportunidade é pagina_produto",
      );
    });

    test("device loss: a cause equal on both devices drops; one with what differs between them stays", () => {
      // fixtures/evidence.ts: F3 = mobile add-to-cart (10%), F8 = desktop (20%).
      const out = parseOpportunityHypotheses(
        JSON.stringify({
          opportunities: [
            {
              rank: 1,
              hypotheses: [
                hyp("o card não mostra desconto"),
                hyp("o banner empurra a lista só no celular", {
                  por_que_no_dispositivo:
                    "no celular 10% põem no carrinho; no computador, 20%",
                  fatos_contraste: ["F3", "F8"],
                }),
              ],
            },
          ],
        }),
        [withMetric("dispositivo")],
        makeEvidence(),
      );
      const kept = out.byOpportunity.get("d:o1") ?? [];
      expect(kept.map((h) => h.title)).toEqual([
        "o banner empurra a lista só no celular",
      ]);
      expect(kept[0]?.tree?.fatos_contraste).toEqual(["F3", "F8"]);
      expect(kept[0]?.evidence_md).toContain("O que muda entre as telas");
      expect(out.dropped.join(" ")).toContain("vale igual nas duas telas");
    });

    test("device loss: the difference must be in the facts, on both sides", () => {
      const why = "no celular 10% põem no carrinho; no computador, 20%";
      const out = parseOpportunityHypotheses(
        JSON.stringify({
          opportunities: [
            {
              rank: 1,
              hypotheses: [
                hyp("sem fato", { por_que_no_dispositivo: why }),
                hyp("só o celular", {
                  por_que_no_dispositivo: "no celular 10% põem no carrinho",
                  fatos_contraste: ["F3"],
                }),
                hyp("id inventado", {
                  por_que_no_dispositivo: why,
                  fatos_contraste: ["F3", "F999"],
                }),
                hyp("número de fora", {
                  por_que_no_dispositivo:
                    "o banner tem 439px no celular e 300px no computador",
                  fatos_contraste: ["F3", "F8"],
                }),
              ],
            },
          ],
        }),
        [withMetric("dispositivo")],
        makeEvidence(),
      );
      expect(out.byOpportunity.get("d:o1") ?? []).toEqual([]);
      const dropped = out.dropped.join(" ");
      expect(dropped).toContain(
        '"sem fato" (a diferença entre as telas não cita um fato do celular e um do computador)',
      );
      expect(dropped).toContain(
        '"só o celular" (a diferença entre as telas não cita',
      );
      expect(dropped).toContain("F999, que não existe");
      expect(dropped).toContain("439px");
    });

    test("absolute loss: a cause that holds on both devices is a cause", () => {
      const out = run(withMetric("absoluta"), [
        hyp("o card não mostra desconto"),
      ]);
      expect(out.byOpportunity.get("d:o1")?.map((h) => h.title)).toEqual([
        "o card não mostra desconto",
      ]);
    });
  });

  test("no prediction drops; contradicted drops; no data stays with low confidence", () => {
    const raw = JSON.stringify({
      opportunities: [
        {
          rank: 1,
          hypotheses: [
            {
              title: "sem previsão",
              idea: "faz",
              why: "porque sim",
              confidence: 0.9,
            },
            {
              title: "contradita",
              idea: "faz",
              why: "porque sim",
              prediction: "grade quebrada converteria menos",
              check: "contradiz",
              check_note: "11,8/mil contra 5/mil",
            },
            {
              title: "sem dado",
              idea: "faz",
              why: "porque sim",
              prediction: "o seletor teria clique morto",
              check: "sem_dado",
              a_favor: [{ texto: "sinal", fatos: ["F3"], tipo: "inferencia" }],
              confidence: 0.8,
            },
          ],
        },
      ],
    });
    const out = parseOpportunityHypotheses(raw, [opportunity], evidence);
    const [h, ...rest] = out.byOpportunity.get("d:o1") ?? [];
    if (!h) throw new Error("expected a hypothesis");
    expect(rest).toEqual([]);
    expect(h.title).toBe("sem dado");
    expect(h.confidence).toBe(0.4);
    expect(h.evidence_md).toContain(
      "**Se for isso:** o seletor teria clique morto",
    );
    expect(out.dropped).toEqual([
      '"sem previsão" (sem previsão que os dados possam conferir)',
      '"contradita" (os próprios dados contradizem: 11,8/mil contra 5/mil)',
    ]);
    expect(out.droppedBy.get("d:o1")).toEqual(out.dropped);
    expect(fallenReason(out, "d:o1")).toBeNull();
  });

  test("a cause an earlier round refuted on this page is dropped in code", () => {
    const raw = JSON.stringify({
      opportunities: [
        {
          rank: 1,
          hypotheses: [
            {
              title: "tamanho escondido",
              idea: "faz",
              why: "porque sim",
              prediction: "o seletor teria clique morto",
              check: "sem_dado",
              a_favor: [{ texto: "sinal", fatos: ["F3"], tipo: "inferencia" }],
              alvo: { kind: "part", key: "size_selector" },
              metrica: { key: "produto_carrinho", direcao: "sobe" },
            },
          ],
        },
      ],
    });
    const [first] =
      parseOpportunityHypotheses(
        raw,
        [opportunity],
        evidence,
      ).byOpportunity.get("d:o1") ?? [];
    const key = first?.tree ? crossRunKey(first.tree) : null;
    if (!key) throw new Error("expected a targeted hypothesis");
    const out = parseOpportunityHypotheses(
      raw,
      [opportunity],
      evidence,
      undefined,
      undefined,
      new Map([[key, { title: "Antes", why: "c1 viu", diagnosisId: "d0" }]]),
    );
    expect(out.byOpportunity.get("d:o1")).toEqual([]);
    expect(out.dropped[0]).toContain("uma rodada anterior já desmentiu");
  });

  test("zero hypotheses is a valid answer", () => {
    const raw = JSON.stringify({
      opportunities: [{ rank: 1, hypotheses: [] }],
    });
    const out = parseOpportunityHypotheses(raw, [opportunity], evidence);
    expect(out.byOpportunity.get("d:o1")).toEqual([]);
    expect(out.dropped).toEqual([]);
    // Valid, but the opportunity does not reach the screen without a hypothesis.
    expect(fallenReason(out, "d:o1")).toBe(
      "nenhuma hipótese que estes dados sustentem",
    );
  });
});

describe("applyChallenge", () => {
  const draft = (title: string, rank: number) => ({
    kind: "proposta" as const,
    opportunity_id: "d:o1",
    rank,
    title,
    device: "mobile" as const,
    evidence_md: "ev",
    idea: "faz",
    why: "",
    where: "",
    money: null,
    confidence: 0.7,
    benchmark_refs: [],
    benchmark: [],
    before_url: null,
  });
  const result = {
    byOpportunity: new Map([["d:o1", [draft("a", 1), draft("b", 2)]]]),
    dropped: [],
    droppedBy: new Map<string, string[]>(),
  };
  const targets = [
    { id: "o1-h1", opportunityId: "d:o1", index: 0 },
    { id: "o1-h2", opportunityId: "d:o1", index: 1 },
  ];

  test("discarded categories survive the review; relations follow the new rank", () => {
    const withTree = (title: string, rank: number, rel: number) => ({
      ...draft(title, rank),
      tree: {
        relacoes: [{ rank: rel, tipo: "concorrente" as const }],
      } as never,
    });
    const r = {
      byOpportunity: new Map([
        [
          "d:o1",
          [withTree("a", 1, 2), withTree("b", 2, 3), withTree("c", 3, 2)],
        ],
      ]),
      dropped: [],
      droppedBy: new Map<string, string[]>(),
      discarded: new Map([
        ["d:o1", [{ category: "performance" as const, why: "LCP ok" }]],
      ]),
    };
    const out = applyChallenge(
      JSON.stringify({
        reviews: [{ id: "o1-h1", verdict: "derrubada", reason: "x" }],
      }),
      [...targets, { id: "o1-h3", opportunityId: "d:o1", index: 2 }],
      r,
    );
    expect(out.discarded?.get("d:o1")).toEqual([
      { category: "performance", why: "LCP ok" },
    ]);
    const [b, c] = out.byOpportunity.get("d:o1") ?? [];
    if (!b || !c) throw new Error("expected two hypotheses");
    // b (was H2) → H1, links to c (was H3, now H2); c linked to b (H2 → H1).
    expect([b.rank, b.tree?.relacoes]).toEqual([
      1,
      [{ rank: 2, tipo: "concorrente" }],
    ]);
    expect([c.rank, c.tree?.relacoes]).toEqual([
      2,
      [{ rank: 1, tipo: "concorrente" }],
    ]);
  });

  test("knocked down leaves and becomes a limitation; weak stays with low confidence and the reason", () => {
    const raw = JSON.stringify({
      reviews: [
        {
          id: "o1-h1",
          verdict: "derrubada",
          reason: "grade quebrada converte mais",
        },
        { id: "o1-h2", verdict: "fraca", reason: "morto é da página inteira" },
      ],
    });
    const out = applyChallenge(raw, targets, result);
    const kept = out.byOpportunity.get("d:o1") ?? [];
    expect(kept.map((h) => [h.rank, h.title, h.confidence])).toEqual([
      [1, "b", 0.4],
    ]);
    expect(kept[0]?.evidence_md).toContain(
      "**Revisão:** morto é da página inteira",
    );
    expect(out.dropped).toEqual([
      '"a" (derrubada na revisão: grade quebrada converte mais)',
    ]);
    expect(out.droppedBy.get("d:o1")).toEqual(out.dropped);
    expect(fallenReason(out, "d:o1")).toBeNull();
  });

  test("all knocked down: the opportunity falls, with the review's reason", () => {
    const raw = JSON.stringify({
      reviews: [
        {
          id: "o1-h1",
          verdict: "derrubada",
          reason: "preço em y=699 numa tela de 844",
        },
        {
          id: "o1-h2",
          verdict: "derrubada",
          reason: "as faixas estão todas em y=2–10",
        },
      ],
    });
    const out = applyChallenge(raw, targets, result);
    expect(out.byOpportunity.get("d:o1")).toEqual([]);
    const reason = fallenReason(out, "d:o1") ?? "";
    expect(reason).toContain("y=699");
    expect(reason).toContain("y=2–10");
    expect(fallenLimit("Preço empurrado", reason)).toContain(
      'Tiramos "Preço empurrado" da tela',
    );
  });

  test("an unreadable answer knocks nothing down: it becomes a limitation", () => {
    const out = applyChallenge("nada de json", targets, result);
    expect(out.byOpportunity.get("d:o1")?.length).toBe(2);
    expect(out.dropped[0]).toContain("revisão contraditória");
  });
});

describe("reading rules that knocked down a search hypothesis", () => {
  for (const pageType of ["pdp", "home", "busca"] as const) {
    test(`${pageType}: dead clicks on page-changing elements and selection bias`, () => {
      const hyp = hypothesesSystem(pageType);
      expect(hyp).toContain("quem usa Y escolheu usar");
      expect(hyp).toContain("página nova demorando");
    });
  }
});

describe("generateOpportunityHypotheses", () => {
  test("lists the causes earlier rounds refuted, only when there are any", async () => {
    const prompts: string[] = [];
    const llm: Llm = async (request) => {
      prompts.push(request.userPrompt);
      return '{"opportunities": []}';
    };
    const base = {
      llm,
      domain: "loja.example",
      evidence,
      opportunities: [],
      onUsage: () => {},
    };
    await generateOpportunityHypotheses(base);
    await generateOpportunityHypotheses({
      ...base,
      refutedBefore: new Map([
        [
          "ux|part:size_selector|produto_carrinho",
          { title: "Tamanho escondido", why: "c1 viu", diagnosisId: "d0" },
        ],
      ]),
    });
    expect(prompts[0]).not.toContain("rodadas anteriores desmentiram");
    expect(prompts[1]).toContain(
      "## Causas que rodadas anteriores desmentiram nesta página",
    );
    expect(prompts[1]).toContain('- "Tamanho escondido": c1 viu');
  });

  test("sends the round's objective and the signed print URLs to the model", async () => {
    const calls: LlmRequest[] = [];
    const llm: Llm = async (request) => {
      calls.push(request);
      return '{"opportunities": []}';
    };
    {
      const fold = "https://app.example/api/media/org-a/ux/d/pdp-main";
      await generateOpportunityHypotheses({
        llm,
        domain: "loja.example",
        evidence: {
          ...evidence,
          captures: [
            {
              device: "mobile",
              url: "https://loja.example/p",
              product_id: null,
              viewport: { width: 390, height: 844 },
              page_height: 3000,
              fold_url: fold,
              full_url: null,
              positions: {},
              has_sticky_buy: false,
              sold_out_signal: false,
              above_fold_outline: [],
              selectors: {},
              dom_excerpt: "",
            },
          ],
        },
        opportunities: [],
        onUsage: () => {},
        objective: "Vender mais vestidos",
        mediaUrl: async (url) => `${url}?exp=1&sig=abc`,
      });
      const [call] = calls;
      expect(call?.systemPrompt).toBe(
        hypothesesSystem("pdp", "Vender mais vestidos"),
      );
      expect(call?.contentParts).toContainEqual({
        type: "image",
        url: `${fold}?exp=1&sig=abc`,
      });
    }
  });
});
