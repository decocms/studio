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

/** Rows as the query returns them (BigQuery integers arrive as strings). */
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
  test("reads only web, the three funnel events and the requested window", () => {
    const sql = buildPageFunnelQuery("projeto", "analytics_1", 7, NOW);
    expect(sql).toContain("`projeto.analytics_1.events_*`");
    expect(sql).toContain("BETWEEN '20261118' AND '20261124'");
    expect(sql).toContain("platform = 'WEB'");
    expect(sql).toContain(
      "event_name IN ('page_view', 'view_item', 'add_to_cart')",
    );
    // Product view / add-to-cart count only AFTER the visit, in the same session.
    expect(sql).toContain("sess.last_view >= pv.t");
    expect(sql).toContain("JOIN sess USING (u, s)");
  });

  test("rejects a project or dataset that is not an identifier", () => {
    expect(() => buildPageFunnelQuery("p`; DROP", "d", 7, NOW)).toThrow();
    expect(() => buildPageFunnelQuery("p", "d.x", 7, NOW)).toThrow();
  });
});

describe("toGa4PageRows", () => {
  test("converts the numbers and removes malformed rows", () => {
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

describe("GA4 routes when Deco Analytics has none", () => {
  test("removes PDPs by template and finds home, search and categories", () => {
    const routes = ga4ListingRoutes(toGa4PageRows(ROWS), "/:product/p");
    expect(routes.map((r) => r.page)).not.toContain("/anel-exemplo-123/p");
    // Sums the devices.
    expect(routes.find((r) => r.page === "/")?.views).toBe(4222);
    const t = detectPageTemplates(routes, "/:product/p", NOW.toISOString());
    expect(t.home).toBe("/");
    expect(t.busca).toBe("/s");
    expect(t.categoria).toEqual(["/joias/aneis", "/relogios"]);
  });
});

describe("ga4FunnelFor", () => {
  test("finds the route with or without a trailing slash, per device", () => {
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

describe("measureMetric with the page funnel in GA4", () => {
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

  test("without a Deco Analytics funnel, measures from GA4 and names the source", () => {
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

  test("with a Deco Analytics funnel, it wins", () => {
    const withDeco = evidence({ ga4_page_funnel: noDeco.ga4_page_funnel });
    const m = measureMetric(
      withDeco,
      { key: "pagina_produto", device: "mobile", compare_to: null },
      "busca",
    );
    expect(m?.source).toBe("deco_analytics");
    expect(m?.n).toBe(40_000);
  });

  test("with neither, it does not measure", () => {
    const none = evidence({ pdp_behaviour: noDeco.pdp_behaviour });
    expect(pageFunnel(none, "busca")).toEqual([]);
  });
});

describe("failedPanels", () => {
  test("merges the panels that failed across devices", () => {
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

/** Registered heatmap with traffic but no funnel rows (a store that does not send the events). */
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

describe("collectEvidence on a search page without a Deco Analytics funnel", () => {
  test("reads the route funnel from GA4 in a single query and leaves no funnel gap", async () => {
    const { out, pageQueries } = await collectBusca(ROWS);
    expect(pageQueries).toBe(1);
    expect(out.evidence.ga4_page_funnel?.route).toBe("/s");
    expect(
      out.evidence.gaps.some((g) => g.error.includes("não tem funil")),
    ).toBe(false);
    expect(pageFunnel(out.evidence as never, "busca")).toHaveLength(2);
  }, 30_000);

  test("GA4 also missing the route: a named gap", async () => {
    const { out } = await collectBusca(ROWS.filter((r) => r.path !== "/s"));
    expect(out.evidence.ga4_page_funnel).toBeUndefined();
    expect(
      out.evidence.gaps.find((g) => g.error.includes("não tem funil"))?.source,
    ).toBe("heatmap");
  }, 30_000);
});
