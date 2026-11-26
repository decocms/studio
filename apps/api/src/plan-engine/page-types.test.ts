import { describe, expect, test } from "bun:test";
import {
  areasForPrompt,
  areasOfDiagnosis,
  asAreaOf,
  isAreaOfPage,
  UX_AREAS,
} from "./areas.ts";
import { evidence } from "./fixtures/evidence.ts";
import { opportunitiesFromLosses } from "./loss-opportunities.ts";
import { findLosses } from "./losses.ts";
import type { UxMetricKey } from "./metrics.ts";
import {
  measureMetric,
  metricFitsPage,
  metricMeasuresPage,
  metricsForPrompt,
  UX_METRICS,
} from "./metrics.ts";
import {
  detectPageTemplates,
  heatmapRouteFor,
  routesFromPages,
  templatesAreStale,
} from "./page-templates.ts";
import { PAGE_TYPE_ORDER, PAGE_TYPES, partWord } from "./page-types.ts";

/** A store's `hmPages` (mobile and desktop, trimmed). */
const SAMPLE_PAGES = [
  {
    page_key: "/:product/p",
    device: "mobile",
    views: 2994201,
    clicks: 1,
    avg_depth: 41.8,
  },
  {
    page_key: "/:product/p",
    device: "desktop",
    views: 360357,
    clicks: 1,
    avg_depth: 68.4,
  },
  {
    page_key: "/buscar",
    device: "mobile",
    views: 263841,
    clicks: 1,
    avg_depth: 72.2,
  },
  {
    page_key: "/colecao/promo",
    device: "mobile",
    views: 247542,
    clicks: 1,
    avg_depth: 68.5,
  },
  {
    page_key: "/",
    device: "mobile",
    views: 242190,
    clicks: 1,
    avg_depth: 48.2,
  },
  {
    page_key: "/novidades",
    device: "mobile",
    views: 183659,
    clicks: 1,
    avg_depth: 60.6,
  },
  {
    page_key: "/buscar",
    device: "desktop",
    views: 70450,
    clicks: 1,
    avg_depth: 90.9,
  },
  {
    page_key: "/minha-conta",
    device: "mobile",
    views: 40000,
    clicks: 1,
    avg_depth: 10,
  },
  {
    page_key: "/colecao/vestidos",
    device: "mobile",
    views: 130672,
    clicks: 1,
    avg_depth: 70.8,
  },
  { page_key: "/", device: "", views: 14475, clicks: 1, avg_depth: 2.6 },
];

describe("site routes (hmPages)", () => {
  test("sums devices and sorts by views", () => {
    const routes = routesFromPages(SAMPLE_PAGES);
    expect(routes[0]!.page).toBe("/:product/p");
    const busca = routes.find((r) => r.page === "/buscar");
    expect(busca?.views).toBe(263841 + 70450);
    // Scroll weighted by views, not a simple average.
    expect(busca?.avg_depth).toBeCloseTo(
      (263841 * 72.2 + 70450 * 90.9) / (263841 + 70450),
      1,
    );
  });

  test("fashion store: home /, search /buscar, categories without PDP, account or search", () => {
    const t = detectPageTemplates(
      routesFromPages(SAMPLE_PAGES),
      "/:product/p",
      "2026-11-16T00:00:00Z",
    );
    expect(t.home).toBe("/");
    expect(t.busca).toBe("/buscar");
    expect(t.categoria).toEqual([
      "/colecao/promo",
      "/novidades",
      "/colecao/vestidos",
    ]);
  });

  test("another store: search is /s", () => {
    const t = detectPageTemplates(
      routesFromPages([
        {
          page_key: "/s",
          device: "mobile",
          views: 16756,
          clicks: 1,
          avg_depth: 50,
        },
        {
          page_key: "/black-friday",
          device: "mobile",
          views: 56278,
          clicks: 1,
          avg_depth: 50,
        },
      ]),
      "/:product/p",
      "2026-11-16T00:00:00Z",
    );
    expect(t.busca).toBe("/s");
    expect(t.categoria).toEqual(["/black-friday"]);
  });

  test("heatmap route per type; checkout has none", () => {
    const t = {
      home: "/",
      busca: "/buscar",
      categoria: ["/colecao/vestidos"],
      detected_at: "",
    };
    expect(heatmapRouteFor("pdp", "/:product/p", t)).toBe("/:product/p");
    expect(heatmapRouteFor("categoria", "/:product/p", t)).toBe(
      "/colecao/vestidos",
    );
    expect(heatmapRouteFor("busca", "/:product/p", null)).toBeNull();
    expect(heatmapRouteFor("carrinho_checkout", "/:product/p", t)).toBeNull();
  });

  test("routes older than a week are re-read", () => {
    const now = Date.parse("2026-11-16T00:00:00Z");
    expect(templatesAreStale(null, now)).toBe(true);
    expect(
      templatesAreStale(
        {
          home: "/",
          busca: null,
          categoria: [],
          detected_at: "2026-11-01T00:00:00Z",
        },
        now,
      ),
    ).toBe(true);
    expect(
      templatesAreStale(
        {
          home: "/",
          busca: null,
          categoria: [],
          detected_at: "2026-11-15T00:00:00Z",
        },
        now,
      ),
    ).toBe(false);
  });
});

describe("page types", () => {
  test("every area of a type exists; parts have a name", () => {
    for (const t of PAGE_TYPE_ORDER) {
      for (const a of PAGE_TYPES[t].areas) expect(a in UX_AREAS).toBe(true);
      for (const part of Object.keys(PAGE_TYPES[t].parts)) {
        expect(partWord(t, part as never).length).toBeGreaterThan(2);
      }
    }
    expect(partWord("busca", "first_card")).toBe("primeiro resultado");
    expect(partWord("categoria", "first_card")).toBe(
      "primeiro card de produto",
    );
  });

  test("the PDP keeps its previous areas (its own + navigation + checkout)", () => {
    expect(areasOfDiagnosis("pdp")).toEqual([
      ...PAGE_TYPES.pdp.areas,
      "navegacao",
      "carrinho_checkout",
    ]);
    expect(areasForPrompt()).toContain("- galeria:");
    expect(areasForPrompt({ pageType: "home" })).not.toContain("- galeria:");
  });

  test("another page's area becomes the whole page", () => {
    expect(asAreaOf("galeria", "home")).toBe("pagina_geral");
    expect(asAreaOf("filtros_ordenacao", "categoria")).toBe(
      "filtros_ordenacao",
    );
    expect(asAreaOf("carrinho_checkout", "home")).toBe("carrinho_checkout");
    expect(isAreaOfPage("pagina_geral", "busca")).toBe(true);
  });

  test("metrics: page funnel only where there is a heatmap", () => {
    expect(metricFitsPage("pdp_carrinho", "pdp")).toBe(true);
    expect(metricFitsPage("pdp_carrinho", "home")).toBe(false);
    expect(metricFitsPage("pagina_produto", "categoria")).toBe(true);
    expect(metricFitsPage("pagina_produto", "pdp")).toBe(false);
    expect(metricFitsPage("pagina_carrinho", "carrinho_checkout")).toBe(false);
    expect(metricFitsPage("checkout_frete", "carrinho_checkout")).toBe(true);
    expect(metricsForPrompt("carrinho_checkout")).not.toContain("pagina_");
    // Each type's default metric exists and applies to it.
    for (const t of PAGE_TYPE_ORDER) {
      const key: UxMetricKey = PAGE_TYPES[t].defaultMetric;
      expect(key in UX_METRICS).toBe(true);
      expect(metricFitsPage(key, t)).toBe(true);
    }
  });
});

describe("1st whole-site round", () => {
  const site = (over: Parameters<typeof evidence>[0] = {}) =>
    evidence({
      platform_funnel: [
        {
          platform: "web_mobile",
          steps: [
            { event: "view_item", count: 196_220 },
            { event: "add_to_cart", count: 8_118 },
            { event: "view_cart", count: 1_733 },
            { event: "begin_checkout", count: 2_515 },
            { event: "view_item_list", count: 121_330 },
            { event: "select_item", count: 28_479 },
          ],
        },
      ],
      ...over,
    });

  test("an inverted open funnel (145%) does not become a rate", () => {
    const ref = {
      key: "vercarrinho_checkout" as const,
      device: "mobile" as const,
      compare_to: null,
    };
    expect(measureMetric(site(), ref, "carrinho_checkout")).toBeNull();
  });

  test("Deco Analytics without 'viewed product' or 'cart' is missing data, not 0%", () => {
    const ev = site({
      page_type: "home",
      pdp_behaviour: [
        {
          ...evidence().pdp_behaviour[0]!,
          funnel: { visitors: 17_276, viewed: 0, carted: 0 },
        },
      ],
    });
    const ref = {
      key: "pagina_produto" as const,
      device: "mobile" as const,
      compare_to: null,
    };
    expect(measureMetric(ev, ref, "home")).toBeNull();
  });

  test("each page keeps its own steps: the PDP's does not measure search", () => {
    expect(metricFitsPage("produto_carrinho", "busca")).toBe(false);
    expect(metricFitsPage("produto_carrinho", "carrinho_checkout")).toBe(false);
    expect(metricFitsPage("lista_produto", "categoria")).toBe(true);
    expect(
      measureMetric(
        site(),
        { key: "lista_produto", device: "mobile", compare_to: null },
        "categoria",
      )?.rate,
    ).toBeCloseTo(28_479 / 121_330, 4);
  });

  test("another page's (or the whole site's) step never becomes this page's loss", () => {
    const ev = site({ page_type: "busca" });
    const keys = findLosses(ev).map((l) => l.key);
    expect(keys).not.toContain("produto_carrinho");
    expect(keys).not.toContain("lista_produto");
    expect(metricMeasuresPage("lista_produto", "busca")).toBe(false);
    expect(metricMeasuresPage("pagina_produto", "busca")).toBe(true);
  });
});

describe("2nd whole-site round", () => {
  test("page without a funnel: no measured loss, no opportunity (used to be R$ 4.7M with no verified basis)", () => {
    const out = opportunitiesFromLosses(
      evidence({
        page_type: "busca",
        pdp_behaviour: [
          {
            ...evidence().pdp_behaviour[0]!,
            funnel: null,
          },
        ],
      }),
    );
    expect(out.opportunities).toEqual([]);
    expect(out.summary.limits.join(" ")).toContain(
      "Nenhuma etapa desta página tem dado",
    );
  });
});
