import { describe, expect, test } from "bun:test";
import { buildFacts } from "./facts.ts";
import {
  sampleFunnel,
  sampleSegments,
  evidence as makeEvidence,
} from "./fixtures/evidence.ts";
import {
  contrastObservations,
  lossResidual,
  MIN_RESIDUAL_PP,
  opportunitiesFromLosses,
} from "./loss-opportunities.ts";
import { findLosses } from "./losses.ts";
import type { DiagnosisEvidence, PageCapture } from "./types.ts";

const revenue = {
  window_days: 28,
  currency: "BRL",
  by_channel: [
    { channel: "APP (9)", orders: 900, revenue: 400_000, avg_ticket: 444 },
    { channel: "Principal (1)", orders: 100, revenue: 30_000, avg_ticket: 300 },
  ],
};

const capture = (
  device: "mobile" | "desktop",
  height: number,
  positions: PageCapture["positions"],
  stock: PageCapture["stock"] = "alive",
): PageCapture => ({
  device,
  url: "https://loja/p",
  product_id: "1",
  viewport: { width: device === "mobile" ? 390 : 1440, height },
  page_height: 5000,
  fold_url: null,
  full_url: null,
  positions,
  has_sticky_buy: false,
  sold_out_signal: false,
  above_fold_outline: [],
  selectors: {},
  dom_excerpt: "",
  stock,
});

// PDP de uma loja de moda (16/11): o tamanho cai abaixo da 1ª tela só no celular.
const captures = [
  capture("mobile", 844, { price: 699, size_selector: 1031, buy_button: 660 }),
  capture("desktop", 900, { price: 187, size_selector: 258, buy_button: 491 }),
];

describe("opportunitiesFromLosses: a oportunidade é a perda com comparação", () => {
  // Celular 10% x computador 20% em viu produto → carrinho (GA4).
  const ev = makeEvidence({ revenue, captures });
  const out = opportunitiesFromLosses(ev);

  test("só perda com comparação entra; a absoluta vira limite com o motivo", () => {
    expect(out.opportunities.map((o) => o.metric?.control)).toEqual([
      "dispositivo",
    ]);
    const o = out.opportunities[0]!;
    expect(o.title).toBe(
      "No celular, 10% de quem vê um produto põe no carrinho; no computador, 20%",
    );
    const limits = out.summary.limits.join(" ");
    expect(limits).toContain("Sem comparação não há como dizer");
    expect(limits).toContain(
      '"No celular, 90% de quem vê um produto não põe no carrinho"',
    );
  });

  test("resumo, área e confiança vêm do código, não de um modelo", () => {
    const o = out.opportunities[0]!;
    expect(o.summary).toBe(
      "O celular fica 10 pp atrás do computador. Não há recorte de público pra descontar a mistura: parte disso pode ser tráfego.",
    );
    expect(o.area).toBe("pagina_geral");
    expect(o.confidence).toBe(
      { alta: 0.8, media: 0.6, baixa: 0.3 }[o.reliability?.level ?? "baixa"],
    );
    expect(out.summary.headline).toContain("A maior perda medida");
  });

  test("as observações são o que muda entre as telas, com o id dos fatos", () => {
    const o = out.opportunities[0]!;
    const facts = buildFacts(ev);
    expect(o.observations).toHaveLength(1);
    const obs = (o.observations ?? [])[0]!;
    expect(obs.text).toBe(
      "seletor de tamanho: no celular, y=1031px, abaixo da 1ª tela (844px): 187px de rolagem; no computador, y=258px, na 1ª tela (que vai até 900px)",
    );
    expect(
      obs.facts.map((id) => facts.find((f) => f.id === id)?.device),
    ).toEqual(["mobile", "desktop"]);
  });

  test("o valor é por 1 pp; o teto é a perda inteira", () => {
    const o = out.opportunities[0]!;
    // 50.000 em 7 dias → 214.286/mês; R$ 300 × 1.000 compras / 5.000
    // carrinhos = R$ 60 por carrinho a mais.
    expect(o.money?.base).toBe(214_286);
    expect(o.money?.value_per_event).toBe(60);
    expect(o.money?.delta_pp).toBe(1);
    expect(o.money?.monthly_value).toBeCloseTo(128_572, -1);
    expect(o.money?.ceiling_monthly).toBe(1_285_716);
  });
});

describe("mistura de público (loja de moda, GA4 de uma semana)", () => {
  const ev: DiagnosisEvidence = makeEvidence({
    revenue,
    platform_funnel: sampleFunnel,
    segments: sampleSegments,
    pdp_behaviour: [],
  });
  const device = findLosses(ev).find((l) => l.control === "dispositivo");

  test("o gap do celular perde a parte que a mistura de canais explica", () => {
    if (!device) throw new Error("sem perda de dispositivo");
    const r = lossResidual(device, ev);
    expect(r.mix?.dim).toBeDefined();
    expect(r.residual_pp).toBeLessThan(r.gap_pp);
    expect(r.residual_pp).toBeCloseTo(r.gap_pp * (1 - (r.mix?.share ?? 0)), 1);
    const o = opportunitiesFromLosses(ev).opportunities.find(
      (x) => x.metric?.control === "dispositivo",
    );
    // 12,98 pp de gap; a mistura de canais explica 20%.
    expect(o?.summary).toBe(
      "O celular fica 13 pp atrás do computador. A mistura de canais explica 20% disso; sobram 10,4 pp pra página explicar.",
    );
  });

  test("segmento: o resumo diz que a causa tem que pesar mais nele", () => {
    const out = opportunitiesFromLosses(ev);
    const seg = [...out.opportunities, ...out.reserves].find(
      (o) => o.metric?.control === "segmento",
    );
    expect(seg?.summary).toMatch(/^[A-ZÀ-Ú]/);
    expect(seg?.summary).toContain("A causa tem que pesar mais nesse público");
    expect(seg?.observations).toEqual([]);
  });

  test("duas da mesma etapa e dispositivo não vão juntas pra tela: a outra é reserva", () => {
    const out = opportunitiesFromLosses(ev);
    const keys = out.opportunities.map((o) => `${o.device}|${o.metric?.key}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(out.reserves.length).toBeGreaterThan(0);
  });
});

describe("perda que o tráfego explica não vira oportunidade", () => {
  test(`resíduo abaixo de ${MIN_RESIDUAL_PP} pp vira limite`, () => {
    // Celular e computador com a mesma taxa em cada canal; o celular só
    // tem mais social pago, que converte pouco nas duas telas.
    const seg = (key: string, platform: string, n: number, cart: number) => ({
      dim: "canal" as const,
      key,
      platform,
      steps: [
        { event: "view_item", count: n },
        { event: "add_to_cart", count: cart },
      ],
    });
    const ev = makeEvidence({
      revenue,
      pdp_behaviour: [],
      platform_funnel: [
        {
          platform: "web_mobile",
          steps: [
            { event: "view_item", count: 100_000 },
            { event: "add_to_cart", count: 8_000 },
          ],
        },
        {
          platform: "web_desktop",
          steps: [
            { event: "view_item", count: 100_000 },
            { event: "add_to_cart", count: 16_000 },
          ],
        },
      ],
      segments: [
        seg("social_pago", "web_mobile", 80_000, 4_000),
        seg("direto", "web_mobile", 20_000, 4_000),
        seg("social_pago", "web_desktop", 20_000, 1_000),
        seg("direto", "web_desktop", 80_000, 15_000),
      ],
    });
    const out = opportunitiesFromLosses(ev);
    expect(
      out.opportunities.some((o) => o.metric?.control === "dispositivo"),
    ).toBe(false);
    expect(out.summary.limits.join(" ")).toContain(
      "Perdas que o tráfego explica, não a página",
    );
  });
});

describe("contrastObservations", () => {
  test("igual nas duas telas não é observação; print de falta não conta", () => {
    const facts = buildFacts(
      makeEvidence({
        captures: [
          // O 1º print do celular é de produto esgotado: fica de fora.
          capture("mobile", 844, { price: 2000 }, "sold_out"),
          capture("mobile", 844, { price: 699, size_selector: 300 }),
          capture("desktop", 900, { price: 187, size_selector: 258 }),
        ],
      }),
    );
    expect(contrastObservations(facts)).toEqual([]);
  });

  test("clique morto do mesmo elemento muito diferente entre as telas", () => {
    const facts = buildFacts(
      makeEvidence({
        pdp_behaviour: [],
        captures: [],
      }),
    ).concat([
      {
        id: "F900",
        kind: "elemento",
        source: "deco_analytics",
        device: "mobile",
        measured: true,
        group: "g",
        text: 'button "Next item" (y=40px) (Product) · 1000 cliques · mortos 82.1% · sem funil',
      },
      {
        id: "F901",
        kind: "elemento",
        source: "deco_analytics",
        device: "desktop",
        measured: true,
        group: "g",
        text: 'button "Next item" (y=40px) (Product) · 500 cliques · mortos 0.5% · sem funil',
      },
    ]);
    expect(contrastObservations(facts)).toEqual([
      {
        text: 'button "Next item" (y=40px) (Product): 82,1% de cliques mortos no celular e 0,5% no computador',
        facts: ["F900", "F901"],
      },
    ]);
  });
});

describe("diferença pequena demais não é problema de tela", () => {
  test("o lado que perde converte mais de 90% do outro: vira limite", () => {
    // Categoria de uma loja de moda (16/11): 49,4% x 51,3% de quem entra abre produto —
    // fora do ruído com 136 mil visitantes, e nada a ver com a tela.
    const ev = makeEvidence({
      revenue,
      pdp_behaviour: [],
      platform_funnel: [
        {
          platform: "web_mobile",
          steps: [
            { event: "view_item", count: 136_000 },
            { event: "add_to_cart", count: 67_200 },
          ],
        },
        {
          platform: "web_desktop",
          steps: [
            { event: "view_item", count: 25_000 },
            { event: "add_to_cart", count: 12_825 },
          ],
        },
      ],
    });
    const out = opportunitiesFromLosses(ev);
    expect(out.opportunities).toEqual([]);
    expect(out.summary.limits.join(" ")).toContain(
      "Diferença entre as telas pequena demais pra ser problema de tela",
    );
  });
});
