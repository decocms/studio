import { describe, expect, test } from "bun:test";
import { buildFacts } from "./facts.ts";
import { evidence as makeEvidence } from "./fixtures/evidence.ts";
import { contrastObservations } from "./loss-opportunities.ts";
import { type ProbeResult, primaryCaptures, touchTargets } from "./probes.ts";
import type { DevicePdpBehaviour, PageCapture } from "./types.ts";

const capture = (
  device: "mobile" | "desktop",
  over: Partial<PageCapture> = {},
): PageCapture => ({
  device,
  url: `https://loja/${device}/p`,
  product_id: "1",
  viewport: { width: device === "mobile" ? 390 : 1440, height: 844 },
  page_height: 5000,
  fold_url: null,
  full_url: null,
  positions: { price: 699, buy_button: 660 },
  has_sticky_buy: false,
  sold_out_signal: false,
  above_fold_outline: [],
  selectors: { price: ".price", buy_button: ".buy" },
  dom_excerpt: "",
  stock: "alive",
  ...over,
});

// A PDP de uma loja em 19/11, medida pela sonda num Chrome local
// (scripts/ux-page-probe.ts --overlays): o pop-up de cadastro abre no
// primeiro movimento do mouse, com película na tela inteira.
const probeMobile: ProbeResult = {
  kind: "camadas",
  device: "mobile",
  url: "https://www.loja.example/anel-prata/p",
  ok: true,
  screenshot_url: null,
  reading: {
    viewport: { width: 390, height: 844 },
    overlays: [
      {
        text: "✕ 20% OFF na primeira compra Cadastre-se e ganhe 20% de desconto",
        area_pct: 61.2,
        top: 150,
        bottom: 694,
        blocks_page: true,
        dims_page: true,
        dialog: false,
      },
    ],
    covered: { price: null, buy_button: null },
  },
};
const probeDesktop: ProbeResult = {
  ...probeMobile,
  device: "desktop",
  reading: {
    viewport: { width: 1440, height: 900 },
    overlays: [{ ...probeMobile.reading.overlays[0]!, area_pct: 14.4 }],
    covered: { price: true, buy_button: true },
  },
};

describe("fatos das sondas", () => {
  const facts = buildFacts(
    makeEvidence({
      captures: [capture("mobile"), capture("desktop")],
      probes: [
        probeMobile,
        probeDesktop,
        {
          kind: "toque",
          device: "mobile",
          url: "https://loja/p",
          ok: true,
          key: "Product|1",
          label: 'button "Next item" (y=40px)',
          observed: "observe_click: nada mudou: mesma URL, sem diálogo",
          clicked: true,
        },
        {
          kind: "camadas",
          device: "desktop",
          url: "https://loja/p",
          ok: false,
          error: "timeout",
        },
      ],
    }),
  );
  const probe = facts.filter((f) => f.kind === "interacao");

  test("o pop-up vira fato medido, com área à vista, película e bloqueio", () => {
    const [layer] = probe;
    expect(layer!.measured).toBe(true);
    expect(layer!.device).toBe("mobile");
    expect(layer!.text).toBe(
      'camada fixa "✕ 20% OFF na primeira compra Cadastre-se e ganhe 20% de desconto": cobre 61.2% da 1ª tela (390×844), de y=150 a y=694px; uma película escurece a tela inteira por trás; o resto da página não responde ao toque enquanto ela está aberta',
    );
  });

  test("parte coberta (ou não) pela camada vira fato; fora da 1ª tela, não", () => {
    const texts = probe.map((f) => f.text);
    expect(texts).toContain(
      "preço: COBERTO por uma camada fixa ao abrir a página",
    );
    expect(texts.filter((t) => t.startsWith("preço:"))).toHaveLength(1);
  });

  test("o toque e a sonda que falhou também viram fato, com o motivo", () => {
    const texts = probe.map((f) => f.text);
    expect(texts).toContain(
      'tocar em button "Next item" (y=40px): observe_click: nada mudou: mesma URL, sem diálogo',
    );
    expect(texts).toContain("a sonda de camadas não rodou: timeout");
  });

  test("a camada que muda entre as telas é observação da perda de dispositivo", () => {
    const [first] = contrastObservations(facts);
    expect(first!.text).toBe(
      "ao abrir a página sem fechar nada: no celular, uma camada fixa cobre 61,2% da 1ª tela; no computador, uma camada fixa cobre 14,4% da 1ª tela",
    );
    expect(first!.facts).toHaveLength(2);
  });
});

describe("o que tocar", () => {
  const behaviour = (elements: DevicePdpBehaviour["elements"]) =>
    ({
      ...makeEvidence().pdp_behaviour[0],
      elements,
    }) as DevicePdpBehaviour;
  const el = (el: string, clicks: number, dead: number) => ({
    root: "Product",
    el,
    section: "Product",
    clicks,
    dead,
    dead_interactive: dead,
    funnel: null,
  });

  test("só clicável com muito morto, achado, que não navega nem está escondido", () => {
    const c = capture("mobile", {
      element_labels: {
        "Product|1": { label: 'button "Next"', y: 40 },
        "Product|2": { label: 'a "Blusas"', y: 45, navigates: "/blusas" },
        "Product|3": { label: 'button "Zoom"', y: 50, hidden: true },
        "Product|4": { label: 'button "Cor"', y: 900 },
        "Product|5": { label: 'button "Poucos"', y: 60 },
      },
    });
    const out = touchTargets(
      makeEvidence({
        pdp_behaviour: [
          behaviour([
            el("1", 10_000, 8_000),
            el("2", 10_000, 9_000),
            el("3", 10_000, 9_000),
            el("4", 10_000, 4_000),
            el("5", 100, 90),
            el("6", 10_000, 9_000),
          ]),
        ],
      }),
      c,
    );
    expect(out).toEqual([
      { key: "Product|1", label: 'button "Next" (y=40px)' },
      { key: "Product|4", label: 'button "Cor" (y=900px)' },
    ]);
  });

  test("a captura de cada tela é a da página de sempre, não a de falta", () => {
    const out = primaryCaptures(
      makeEvidence({
        captures: [
          capture("mobile", { stock: "broken_grid", url: "falta" }),
          capture("mobile", { url: "normal" }),
          capture("desktop"),
        ],
      }),
    );
    expect(out.map((c) => c.url)).toEqual(["normal", "https://loja/desktop/p"]);
  });
});
