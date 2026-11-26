import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { __setPageWaitForTesting } from "./browser.ts";
import { buildFacts } from "./facts.ts";
import { evidence as makeEvidence } from "./fixtures/evidence.ts";
import { contrastObservations } from "./loss-opportunities.ts";
import { fakeBrowser } from "./fixtures/fake-browser.ts";
import { overlaysInPage } from "./page-scripts.ts";
import type { MediaStore } from "./ports.ts";
import {
  type ProbeResult,
  primaryCaptures,
  runProbes,
  touchTargets,
} from "./probes.ts";
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

// A PDP measured by the probe in a local Chrome (scripts/ux-page-probe.ts --overlays): the signup pop-up opens on the first mouse move, with a full-screen overlay.
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

describe("probe facts", () => {
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

  test("the pop-up becomes a measured fact, with visible area, overlay and blocking", () => {
    const [layer] = probe;
    expect(layer!.measured).toBe(true);
    expect(layer!.device).toBe("mobile");
    expect(layer!.text).toBe(
      'camada fixa "✕ 20% OFF na primeira compra Cadastre-se e ganhe 20% de desconto": cobre 61.2% da 1ª tela (390×844), de y=150 a y=694px; uma película escurece a tela inteira por trás; o resto da página não responde ao toque enquanto ela está aberta',
    );
  });

  test("a part covered (or not) by the layer becomes a fact; outside the first screen, it does not", () => {
    const texts = probe.map((f) => f.text);
    expect(texts).toContain(
      "preço: COBERTO por uma camada fixa ao abrir a página",
    );
    expect(texts.filter((t) => t.startsWith("preço:"))).toHaveLength(1);
  });

  test("the touch and the failed probe also become facts, with the reason", () => {
    const texts = probe.map((f) => f.text);
    expect(texts).toContain(
      'tocar em button "Next item" (y=40px): observe_click: nada mudou: mesma URL, sem diálogo',
    );
    expect(texts).toContain("a sonda de camadas não rodou: timeout");
  });

  test("a layer that changes between screens is an observation of the device loss", () => {
    const [first] = contrastObservations(facts);
    expect(first!.text).toBe(
      "ao abrir a página sem fechar nada: no celular, uma camada fixa cobre 61,2% da 1ª tela; no computador, uma camada fixa cobre 14,4% da 1ª tela",
    );
    expect(first!.facts).toHaveLength(2);
  });
});

describe("what to touch", () => {
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

  test("only clickable with many dead clicks, found, not navigating or hidden", () => {
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

  test("each screen's capture is the usual page, not the missing state", () => {
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

describe("runProbes", () => {
  let restoreWait: () => void;
  beforeAll(() => {
    restoreWait = __setPageWaitForTesting(async () => {});
  });
  afterAll(() => restoreWait());

  const media: MediaStore = {
    put: async (path) => path,
    get: async () => null,
    url: async (path) => path,
  };
  const reading = {
    viewport: { width: 390, height: 844 },
    overlays: [],
    covered: { price: false, buy_button: false },
  };
  const noWait = async () => {};

  test("layers: opens with tracking blocked, leaves the pop-up open, measures and stores the screenshot", async () => {
    const f = fakeBrowser(() => ({
      scripts: new Map([[overlaysInPage, () => reading]]),
    }));
    const out = await runProbes({
      browser: f.browser,
      evidence: makeEvidence({ captures: [capture("mobile")] }),
      media,
      keyPrefix: "ux/d1/sondas",
      deadline: Date.now() + 60_000,
      sleep: noWait,
    });
    expect(out).toEqual([
      {
        kind: "camadas",
        device: "mobile",
        url: "https://loja/mobile/p",
        ok: true,
        reading,
        screenshot_url: "ux/d1/sondas/camadas-mobile.jpg",
      },
    ]);
    expect(f.blockers[0]?.("https://www.google-analytics.com/g/collect")).toBe(
      true,
    );
  });

  test("a page that does not open becomes a result with the reason, never an error", async () => {
    const f = fakeBrowser(() => ({
      goto: () => ({
        error: "net::ERR_CONNECTION_REFUSED",
        landsOn: "chrome-error://chromewebdata/",
      }),
    }));
    const out = await runProbes({
      browser: f.browser,
      evidence: makeEvidence({ captures: [capture("desktop")] }),
      media,
      keyPrefix: "ux/d1/sondas",
      deadline: Date.now() + 60_000,
      sleep: noWait,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.ok).toBe(false);
    expect(out[0]?.ok === false && out[0].error).toContain(
      "net::ERR_CONNECTION_REFUSED",
    );
  });

  test("past the deadline, no probe starts", async () => {
    const f = fakeBrowser(() => ({}));
    const out = await runProbes({
      browser: f.browser,
      evidence: makeEvidence({ captures: [capture("mobile")] }),
      media,
      keyPrefix: "ux/d1/sondas",
      deadline: Date.now() - 1,
      sleep: noWait,
    });
    expect(out).toEqual([]);
    expect(f.visited).toEqual([]);
  });
});
