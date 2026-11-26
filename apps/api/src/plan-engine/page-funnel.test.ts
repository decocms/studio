import { describe, expect, test } from "bun:test";
import {
  buildPageFunnelQuery,
  collectEvidence,
  failedPanels,
  ga4FunnelFor,
  ga4ListingRoutes,
  toGa4PageRows,
} from "./collect.ts";
import { evidence } from "./fixtures/evidence.ts";
import { measureMetric } from "./metrics.ts";
import { detectPageTemplates } from "./page-templates.ts";
import { pageFunnel } from "./store-view.ts";
import type { HeatmapPayload } from "./ports.ts";
import type { SiteProfile } from "./types.ts";

const NOW = new Date("2026-11-25T12:00:00Z");

/** Linhas como a consulta devolve (inteiros do BigQuery chegam como texto). */
const ROWS = [
  {
    device: "mobile",
    path: "/",
    visitors: "3210",
    viewed: "1100",
    carted: "266",
  },
  {
    device: "desktop",
    path: "/",
    visitors: "1012",
    viewed: "370",
    carted: "141",
  },
  {
    device: "mobile",
    path: "/s",
    visitors: "1322",
    viewed: "734",
    carted: "189",
  },
  {
    device: "desktop",
    path: "/s",
    visitors: "433",
    viewed: "285",
    carted: "105",
  },
  {
    device: "mobile",
    path: "/joias/aneis",
    visitors: "983",
    viewed: "500",
    carted: "95",
  },
  {
    device: "mobile",
    path: "/anel-exemplo-123/p",
    visitors: "1207",
    viewed: "756",
    carted: "47",
  },
  {
    device: "mobile",
    path: "/account",
    visitors: "212",
    viewed: "100",
    carted: "51",
  },
  {
    device: "mobile",
    path: "/relogios",
    visitors: "781",
    viewed: "317",
    carted: "54",
  },
];

describe("buildPageFunnelQuery", () => {
  test("lê só web, os três eventos do funil e a janela pedida", () => {
    const sql = buildPageFunnelQuery("projeto", "analytics_1", 7, NOW);
    expect(sql).toContain("`projeto.analytics_1.events_*`");
    expect(sql).toContain("BETWEEN '20261118' AND '20261124'");
    expect(sql).toContain("platform = 'WEB'");
    expect(sql).toContain(
      "event_name IN ('page_view', 'view_item', 'add_to_cart')",
    );
    // Viu produto / carrinho contam só DEPOIS da visita, na mesma sessão.
    expect(sql).toContain("sess.last_view >= pv.t");
    expect(sql).toContain("JOIN sess USING (u, s)");
  });

  test("recusa projeto ou dataset que não é identificador", () => {
    expect(() => buildPageFunnelQuery("p`; DROP", "d", 7, NOW)).toThrow();
    expect(() => buildPageFunnelQuery("p", "d.x", 7, NOW)).toThrow();
  });
});

describe("toGa4PageRows", () => {
  test("converte os números e tira linha malformada", () => {
    const rows = toGa4PageRows([
      ...ROWS.slice(0, 1),
      { device: "tablet", path: "/", visitors: "5", viewed: "1", carted: "0" },
      {
        device: "mobile",
        path: "sem-barra",
        visitors: "5",
        viewed: "1",
        carted: "0",
      },
      { device: "mobile", path: "/x", visitors: "0", viewed: "0", carted: "0" },
      {
        device: "mobile",
        path: "/y",
        visitors: "9",
        viewed: "-1",
        carted: "0",
      },
    ]);
    expect(rows).toEqual([
      {
        device: "mobile",
        path: "/",
        visitors: 3210,
        viewed: 1100,
        carted: 266,
      },
    ]);
  });
});

describe("rotas do GA4 quando o Deco Analytics não tem", () => {
  test("tira as PDPs pelo template e acha home, busca e categorias", () => {
    const routes = ga4ListingRoutes(toGa4PageRows(ROWS), "/:product/p");
    expect(routes.map((r) => r.page)).not.toContain("/anel-exemplo-123/p");
    // Soma os dispositivos.
    expect(routes.find((r) => r.page === "/")?.views).toBe(4222);
    const t = detectPageTemplates(routes, "/:product/p", NOW.toISOString());
    expect(t.home).toBe("/");
    expect(t.busca).toBe("/s");
    expect(t.categoria).toEqual(["/joias/aneis", "/relogios"]);
  });
});

describe("ga4FunnelFor", () => {
  test("acha a rota com ou sem barra final, por dispositivo", () => {
    const rows = toGa4PageRows(ROWS);
    expect(ga4FunnelFor(rows, "/s/")).toEqual({
      route: "/s",
      by_device: [
        { device: "mobile", visitors: 1322, viewed: 734, carted: 189 },
        { device: "desktop", visitors: 433, viewed: 285, carted: 105 },
      ],
    });
    expect(ga4FunnelFor(rows, "/nao-existe")).toBeNull();
  });
});

describe("measureMetric com o funil da página no GA4", () => {
  const noDeco = evidence({
    pdp_behaviour: [
      {
        device: "mobile",
        views: 20_000,
        avg_depth_pct: 60,
        avg_fold_pct: 16,
        active_seconds: 29,
        clicks: 0,
        dead_clicks: 0,
        reach: { p25: 0, p50: 0, p75: 0 },
        funnel: null,
        sections: [],
      },
    ],
    ga4_page_funnel: {
      route: "/s",
      by_device: [
        { device: "mobile", visitors: 1322, viewed: 734, carted: 189 },
        { device: "desktop", visitors: 433, viewed: 285, carted: 105 },
      ],
    },
  });

  test("sem funil do Deco Analytics, mede pelo GA4 e diz a fonte", () => {
    const m = measureMetric(
      noDeco,
      { key: "pagina_produto", device: "mobile", compare_to: "desktop" },
      "busca",
    );
    expect(m?.source).toBe("ga4");
    expect(m?.n).toBe(1322);
    expect(m?.hits).toBe(734);
    expect(m?.comp?.n).toBe(433);
    expect(pageFunnel(noDeco, "busca")).toHaveLength(2);
  });

  test("com funil do Deco Analytics, ele vence", () => {
    const withDeco = evidence({ ga4_page_funnel: noDeco.ga4_page_funnel });
    const m = measureMetric(
      withDeco,
      { key: "pagina_produto", device: "mobile", compare_to: null },
      "busca",
    );
    expect(m?.source).toBe("deco_analytics");
    expect(m?.n).toBe(40_000);
  });

  test("sem nenhum dos dois, não mede", () => {
    const none = evidence({ pdp_behaviour: noDeco.pdp_behaviour });
    expect(pageFunnel(none, "busca")).toEqual([]);
  });
});

describe("failedPanels", () => {
  test("junta os painéis que falharam nos dispositivos", () => {
    const p = (failed?: string[]): HeatmapPayload => ({
      registered: true,
      siteId: "s",
      data: failed ? { failedPanels: failed } : {},
    });
    expect(
      failedPanels([p(["hmFunnel"]), p(["hmFunnel", "hmScroll"]), p()]),
    ).toEqual(["hmFunnel", "hmScroll"]);
  });
});

/** Heatmap registrado, com tráfego e sem linha de funil (loja que não manda os eventos). */
const heatmapNoFunnel = {
  registered: true,
  siteId: "s",
  data: {
    hmSummary: [
      {
        views: 20_000,
        avg_depth: 60,
        avg_fold: 16,
        active_s: 29,
        clicks: 10,
        dead: 1,
      },
    ],
    hmElements: [
      { root: "site/sections/Product/SearchResult.tsx#0", el: "1", clicks: 10 },
    ],
    hmFunnel: [],
    hmPages: [
      {
        page_key: "/",
        device: "mobile",
        views: 9000,
        clicks: 1,
        avg_depth: 50,
      },
      {
        page_key: "/s",
        device: "mobile",
        views: 5000,
        clicks: 1,
        avg_depth: 60,
      },
    ],
  },
};

async function collectBusca(rows: Record<string, unknown>[]) {
  const queries: string[] = [];
  const bigquery = {
    run: async (args: Record<string, unknown>) => {
      const query = String(args.query ?? "");
      queries.push(query);
      if (query.includes("page_location")) return { rows };
      return { rows: [] };
    },
    projectId: "projeto",
    datasetId: "analytics_1",
  };
  const out = await collectEvidence({
    profile: {
      domain: "loja.example",
      studio_site: "loja",
      pdp_path_template: "/:product/p",
      page_templates: {
        home: "/",
        busca: "/s",
        categoria: ["/joias/aneis"],
        detected_at: NOW.toISOString(),
      },
    } as unknown as SiteProfile,
    pageType: "busca",
    orgSlug: "org-a",
    heatmap: async () => heatmapNoFunnel as HeatmapPayload,
    lake: async () => [],
    bigquery,
    vtex: null,
    fetch: (async () =>
      new Response("não achei", { status: 404 })) as unknown as typeof fetch,
  });
  return {
    out,
    pageQueries: queries.filter((q) => q.includes("page_location")).length,
  };
}

describe("collectEvidence numa busca sem funil no Deco Analytics", () => {
  test("lê o funil da rota no GA4, uma consulta só, e não deixa lacuna de funil", async () => {
    const { out, pageQueries } = await collectBusca(ROWS);
    expect(pageQueries).toBe(1);
    expect(out.evidence.ga4_page_funnel?.route).toBe("/s");
    expect(
      out.evidence.gaps.some((g) => g.error.includes("não tem funil")),
    ).toBe(false);
    expect(pageFunnel(out.evidence as never, "busca")).toHaveLength(2);
  }, 30_000);

  test("o GA4 também sem a rota: lacuna nomeada", async () => {
    const { out } = await collectBusca(ROWS.filter((r) => r.path !== "/s"));
    expect(out.evidence.ga4_page_funnel).toBeUndefined();
    expect(
      out.evidence.gaps.find((g) => g.error.includes("não tem funil"))?.source,
    ).toBe("heatmap");
  }, 30_000);
});
