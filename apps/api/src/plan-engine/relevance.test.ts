import { describe, expect, test } from "bun:test";
import { evidence as makeEvidence } from "./fixtures/evidence.ts";
import { computeRelevance, reachAtDepth } from "./relevance.ts";
import type { HypothesisTree } from "./tree.ts";
import type { DevicePdpBehaviour, PageCapture } from "./types.ts";

const behaviour = (
  over: Partial<DevicePdpBehaviour> = {},
): DevicePdpBehaviour => ({
  device: "mobile",
  views: 100_000,
  avg_depth_pct: 40,
  avg_fold_pct: 20,
  active_seconds: 30,
  clicks: 10_000,
  dead_clicks: 500,
  reach: { p25: 80, p50: 40, p75: 20 },
  funnel: { visitors: 100_000, viewed: 100_000, carted: 5_000 },
  sections: [
    {
      section: "Product/Shelf",
      reach_pct: 12,
      avg_seconds: 3,
      ctr_pct: 1,
      clicks: 50,
    },
  ],
  elements: [
    {
      root: "r",
      el: "1",
      section: "Product/ProductDetails",
      clicks: 2_000,
      dead: 0,
      dead_interactive: 20,
      funnel: { visitors: 1_500, carted: 300 },
    },
  ],
  scroll_curve: Array.from({ length: 21 }, (_, i) => ({
    depth: i * 5,
    reach_pct: 100 - i * 4,
  })),
  ...over,
});

const capture = {
  device: "mobile",
  url: "https://loja/p",
  viewport: { width: 390, height: 844 },
  page_height: 5_000,
  positions: {
    price: 600,
    size_selector: 1_250,
    buy_button: 1_400,
    shipping: null,
    first_recommendation: 2_500,
  },
  element_labels: { "r|1": { label: 'label "PP"', y: 1_250 } },
} as unknown as PageCapture;

const tree = (over: Partial<HypothesisTree>): HypothesisTree =>
  ({
    posicao_depois: "mesma",
    alvo: { kind: "part", key: "size_selector", label: "seletor de tamanho" },
    ...over,
  }) as HypothesisTree;

const ev = makeEvidence({ pdp_behaviour: [behaviour()], captures: [capture] });

describe("reachAtDepth", () => {
  test("interpolates the curve; without a curve, uses the three marks", () => {
    const b = behaviour();
    expect(reachAtDepth(b, 25)).toBe(80);
    expect(reachAtDepth(b, 27.5)).toBe(78);
    const old = behaviour({ scroll_curve: undefined });
    expect(reachAtDepth(old, 37.5)).toBe(60);
    expect(reachAtDepth(old, 0)).toBe(100);
  });
});

describe("computeRelevance", () => {
  test("below the fold and the change moves it to the first screen: reaches everyone → high", () => {
    const r = computeRelevance(
      { device: "mobile", tree: tree({ posicao_depois: "primeira_tela" }) },
      ev,
      "t",
    );
    // y=1250 on a 5000 page = 25% → 80% reach it
    expect(r?.reach_pct).toBe(80);
    expect(r?.affected_pct).toBe(100);
    expect(r?.views_week).toBe(100_000);
    expect(r?.level).toBe("alta");
  });

  test("in-place change only reaches those who get there; no strong signal → medium", () => {
    const r = computeRelevance(
      {
        device: "mobile",
        tree: tree({
          alvo: { kind: "part", key: "first_recommendation", label: "vitrine" },
        }),
      },
      ev,
      "t",
    );
    // y=2500 = 50% → 60%
    expect(r?.affected_pct).toBe(60);
    expect(r?.level).toBe("media");
  });

  test("section almost nobody reaches: low", () => {
    const r = computeRelevance(
      {
        device: "mobile",
        tree: tree({
          alvo: { kind: "section", key: "Product/Shelf", label: "vitrine" },
        }),
      },
      ev,
      "t",
    );
    expect(r?.reach_pct).toBe(12);
    expect(r?.level).toBe("baixa");
  });

  test("in the first screen = 100%; element signals compare against the page", () => {
    const r = computeRelevance(
      {
        device: "mobile",
        tree: tree({
          alvo: { kind: "element", key: "r|1", label: 'label "PP"' },
        }),
      },
      makeEvidence({
        pdp_behaviour: [behaviour()],
        captures: [
          {
            ...capture,
            element_labels: { "r|1": { label: 'label "PP"', y: 500 } },
          } as PageCapture,
        ],
      }),
      "t",
    );
    expect(r?.reach_pct).toBe(100);
    // Rage click is no longer among the signals: not reliable
    expect(r?.signals.find((s) => s.label === "Raiva")).toBeUndefined();
    const cart = r?.signals.find((s) => s.label === "Carrinho");
    expect(cart?.ratio).toBe(4);
    expect(r?.level).toBe("alta");
  });

  test("few people per week: no relevance; without Deco Analytics: null", () => {
    const few = makeEvidence({
      pdp_behaviour: [behaviour({ views: 300 })],
      captures: [capture],
    });
    expect(
      computeRelevance({ device: "mobile", tree: tree({}) }, few, "t")?.level,
    ).toBe("sem_relevancia");
    expect(
      computeRelevance(
        { device: "mobile", tree: tree({}) },
        makeEvidence({ pdp_behaviour: [] }),
        "t",
      ),
    ).toBeNull();
  });

  test("hypothesis without a target applies to the whole page", () => {
    const r = computeRelevance(
      { device: "mobile", tree: tree({ alvo: null }) },
      ev,
      "t",
    );
    expect(r?.reach_pct).toBeNull();
    expect(r?.affected_pct).toBe(100);
  });
});

describe("section over the page", () => {
  test("popup with 1.6% reach and 957% CTR: the floor is clicks ÷ views, with the section signals", () => {
    const b = behaviour({
      views: 424_518,
      clicks: 416_910,
      dead_clicks: 48_000,
      sections: [
        {
          section: "newsletter-popup/NewsletterPopup",
          reach_pct: 1.6,
          avg_seconds: 3,
          ctr_pct: 957.4,
          clicks: 141_129,
        },
      ],
      elements: [
        {
          root: "site/sections/newsletter-popup/NewsletterPopup.tsx#0",
          el: "1",
          section: "newsletter-popup/NewsletterPopup",
          clicks: 31_438,
          dead: 8_820,
          dead_interactive: 0,
          funnel: null,
        },
      ],
    });
    const r = computeRelevance(
      {
        device: "mobile",
        tree: tree({
          alvo: {
            kind: "section",
            key: "newsletter-popup/NewsletterPopup",
            label: "pop-up de newsletter",
          },
        }),
      },
      makeEvidence({ pdp_behaviour: [b], captures: [capture] }),
      "t",
    );
    // 141,129 ÷ 424,518 = 33%
    expect(r?.reach_pct).toBeCloseTo(33.2, 1);
    expect(r?.basis).toContain("fica por cima da página");
    expect(r?.signals.find((s) => s.label === "Clique")).toBeDefined();
    expect(r?.level).toBe("media");
  });
});

describe("dead click on an element that changes page (search on a fashion store)", () => {
  // The search submit is a "dead click" only because the results page takes over 1 s to load
  const homeMobile = behaviour({
    views: 246_306,
    clicks: 534_394,
    dead_clicks: 47_038,
    funnel: { visitors: 162_639, viewed: 52_316, carted: 14_386 },
    elements: [
      {
        root: "h",
        el: "open",
        section: "Header/Header",
        clicks: 18_499,
        dead: 15,
        dead_interactive: 15,
        funnel: { visitors: 15_233, carted: 3_424 },
      },
      {
        root: "h",
        el: "submit",
        section: "Header/Header",
        clicks: 18_130,
        dead: 10_164,
        dead_interactive: 10_164,
        funnel: { visitors: 12_263, carted: 2_833 },
      },
    ],
  });
  const labels = {
    "h|open": { label: 'label "open search"', y: 40 },
    "h|submit": {
      label: 'button "Search term"',
      y: 0,
      navigates: "/buscar",
      hidden: true,
    },
  };
  const homeEv = makeEvidence({
    pdp_behaviour: [homeMobile],
    captures: [{ ...capture, element_labels: labels } as PageCapture],
  });
  const on = (key: string) =>
    computeRelevance(
      {
        device: "mobile",
        tree: tree({ alvo: { kind: "element", key, label: "busca" } }),
      },
      homeEv,
      "t",
    );

  test("search submit does not get a dead-click signal", () => {
    const r = on("h|submit");
    expect(r?.signals.map((s) => s.label)).not.toContain("Clique morto");
    // And the cart says it measures those who chose to click
    expect(r?.signals.find((s) => s.label === "Carrinho")?.value).toContain(
      "escolheu clicar",
    );
  });

  test("hidden on load: y=0 does not become 'in the first screen'", () => {
    const r = on("h|submit");
    expect(r?.reach_pct).toBeNull();
    expect(r?.basis).toContain("não deu pra achar");
  });

  test("the magnifier, which changes its own page, keeps the signal", () => {
    const r = on("h|open");
    expect(r?.signals.map((s) => s.label)).toContain("Clique morto");
  });

  test("section: the submit's dead clicks do not enter the sum", () => {
    const r = computeRelevance(
      {
        device: "mobile",
        tree: tree({
          alvo: { kind: "section", key: "Header/Header", label: "cabeçalho" },
        }),
      },
      homeEv,
      "t",
    );
    const dead = r?.signals.find((s) => s.label === "Clique morto");
    expect(dead?.value).toStartWith("0,1% dos cliques");
  });
});
