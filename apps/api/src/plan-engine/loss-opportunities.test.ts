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

// A PDP where the size falls below the first screen only on mobile.
const captures = [
  capture("mobile", 844, { price: 699, size_selector: 1031, buy_button: 660 }),
  capture("desktop", 900, { price: 187, size_selector: 258, buy_button: 491 }),
];

describe("opportunitiesFromLosses: the opportunity is the loss with a comparison", () => {
  // Mobile 10% x desktop 20% in viewed product → cart (GA4).
  const ev = makeEvidence({ revenue, captures });
  const out = opportunitiesFromLosses(ev);

  test("only a loss with a comparison enters; the absolute one becomes a limit with the reason", () => {
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

  test("summary, area and confidence come from code, not a model", () => {
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

  test("observations are what changes between screens, with the fact id", () => {
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

  test("the value is per 1 pp; the cap is the whole loss", () => {
    const o = out.opportunities[0]!;
    // 50,000 in 7 days → 214,286/month; R$ 300 × 1,000 purchases / 5,000 carts = R$ 60 per extra cart.
    expect(o.money?.base).toBe(214_286);
    expect(o.money?.value_per_event).toBe(60);
    expect(o.money?.delta_pp).toBe(1);
    expect(o.money?.monthly_value).toBeCloseTo(128_572, -1);
    expect(o.money?.ceiling_monthly).toBe(1_285_716);
  });
});

describe("audience mix (GA4, one week)", () => {
  const ev: DiagnosisEvidence = makeEvidence({
    revenue,
    platform_funnel: sampleFunnel,
    segments: sampleSegments,
    pdp_behaviour: [],
  });
  const device = findLosses(ev).find((l) => l.control === "dispositivo");

  test("the mobile gap loses the part the channel mix explains", () => {
    if (!device) throw new Error("sem perda de dispositivo");
    const r = lossResidual(device, ev);
    expect(r.mix?.dim).toBeDefined();
    expect(r.residual_pp).toBeLessThan(r.gap_pp);
    expect(r.residual_pp).toBeCloseTo(r.gap_pp * (1 - (r.mix?.share ?? 0)), 1);
    const o = opportunitiesFromLosses(ev).opportunities.find(
      (x) => x.metric?.control === "dispositivo",
    );
    // 12.98 pp of gap; the channel mix explains 20%.
    expect(o?.summary).toBe(
      "O celular fica 13 pp atrás do computador. A mistura de canais explica 20% disso; sobram 10,4 pp pra página explicar.",
    );
  });

  test("segment: the summary says the cause must weigh more on it", () => {
    const out = opportunitiesFromLosses(ev);
    const seg = [...out.opportunities, ...out.reserves].find(
      (o) => o.metric?.control === "segmento",
    );
    expect(seg?.summary).toMatch(/^[A-ZÀ-Ú]/);
    expect(seg?.summary).toContain("A causa tem que pesar mais nesse público");
    expect(seg?.observations).toEqual([]);
  });

  test("two of the same stage and device do not go to the screen together: the other is a reserve", () => {
    const out = opportunitiesFromLosses(ev);
    const keys = out.opportunities.map((o) => `${o.device}|${o.metric?.key}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(out.reserves.length).toBeGreaterThan(0);
  });
});

describe("a loss the traffic explains does not become an opportunity", () => {
  test(`residual below ${MIN_RESIDUAL_PP} pp becomes a limit`, () => {
    // Same rate per channel on both devices; mobile only has more paid social, which converts little on both.
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
  test("equal on both screens is not an observation; a missing-state screenshot does not count", () => {
    const facts = buildFacts(
      makeEvidence({
        captures: [
          // Mobile's first screenshot is an out-of-stock product: left out.
          capture("mobile", 844, { price: 2000 }, "sold_out"),
          capture("mobile", 844, { price: 699, size_selector: 300 }),
          capture("desktop", 900, { price: 187, size_selector: 258 }),
        ],
      }),
    );
    expect(contrastObservations(facts)).toEqual([]);
  });

  test("the same element's dead click very different between screens", () => {
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

describe("a difference too small is not a screen problem", () => {
  test("the losing side converts more than 90% of the other: becomes a limit", () => {
    // A category page: 49.4% x 51.3% open a product - outside the noise at 136k visitors, and unrelated to the screen.
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
