import { describe, expect, test } from "bun:test";
import {
  buildFunnelSegmentsQuery,
  buildPlatformFunnelQuery,
  collectEvidence,
  isBigQuerySetupError,
  type ProductRow,
  pickCaptureTargets,
  pickElements,
  toDeviceBehaviour,
  toFunnelSegments,
  toPlatformFunnels,
} from "./collect.ts";
import { heatmapPdpMobile as heatmap } from "./fixtures/heatmap-pdp-mobile.ts";
import type { HeatmapPayload, HeatmapReader, LakeQuery } from "./ports.ts";
import type { SiteProfile } from "./types.ts";

const noLake: LakeQuery = async () => [];
const unregistered: HeatmapReader = async () => ({
  registered: false,
  siteId: null,
  data: {},
});
const offline = (async () => {
  throw new Error("offline");
}) as unknown as typeof fetch;

describe("toDeviceBehaviour (payload de uma PDP no celular)", () => {
  const b = toDeviceBehaviour("mobile", heatmap);

  test("lê o resumo: rolagem, dobra, cliques mortos", () => {
    expect(b?.views).toBe(120_000);
    expect(b?.avg_depth_pct).toBe(47.4);
    expect(b?.avg_fold_pct).toBe(17.1);
    expect(b?.dead_clicks).toBe(25_000);
  });

  test("lê a curva de rolagem nos pontos 25/50/75", () => {
    expect(b?.reach.p25).toBe(70.2);
    expect(b?.reach.p50).toBe(39.7);
    expect(b?.reach.p75).toBeGreaterThan(0);
    expect(b?.reach.p75).toBeLessThan(b?.reach.p50 ?? 0);
  });

  test("o funil da página é a linha de root vazio e el 0", () => {
    expect(b?.funnel).toEqual({
      visitors: 56_000,
      viewed: 21_000,
      carted: 3_000,
    });
  });

  test("tira as seções que não são conteúdo (tema, pixel, VWO)", () => {
    const names = b?.sections.map((s) => s.section) ?? [];
    expect(names).toContain("Product/ProductDetails");
    expect(
      names.some((n) => /Theme|Tracking|VWO|PageAssets|Fonts/.test(n)),
    ).toBe(false);
    expect(b?.sections.every((s) => s.clicks > 0)).toBe(true);
  });

  test("sem resumo (site sem dado) volta null", () => {
    expect(
      toDeviceBehaviour("desktop", {
        registered: true,
        siteId: null,
        data: {},
      }),
    ).toBeNull();
  });
});

describe("toPlatformFunnels", () => {
  test("agrupa por plataforma, ordena web primeiro e zera evento ausente", () => {
    const funnels = toPlatformFunnels([
      { platform: "app_ios", event_name: "view_item", users: 10 },
      { platform: "web_mobile", event_name: "view_item", users: 100 },
      { platform: "web_mobile", event_name: "add_to_cart", users: 14 },
    ]);
    expect(funnels.map((f) => f.platform)).toEqual(["web_mobile", "app_ios"]);
    const mobile = funnels[0]?.steps ?? [];
    expect(mobile.find((s) => s.event === "add_to_cart")?.count).toBe(14);
    expect(mobile.find((s) => s.event === "purchase")?.count).toBe(0);
  });
});

describe("buildPlatformFunnelQuery", () => {
  test("recusa projeto com caractere estranho (vai pro SQL)", () => {
    expect(() => buildPlatformFunnelQuery("p; DROP", "d", 7)).toThrow();
  });

  test("lê só dias completos e só as colunas estreitas", () => {
    const sql = buildPlatformFunnelQuery(
      "example-project",
      "analytics_123456",
      7,
      new Date("2026-11-04T12:00:00Z"),
    );
    expect(sql).toContain("BETWEEN '20261028' AND '20261103'");
    expect(sql).not.toContain("event_params");
    expect(sql).toContain("COUNT(DISTINCT user_pseudo_id)");
  });
});

describe("pickElements", () => {
  const root = "site/sections/Product/ProductInfo.tsx#0";
  const payload = {
    registered: true,
    siteId: "s",
    data: {
      hmElements: [
        { root, el: "1", clicks: 9000, dead: 3000, dead_int: 5 },
        { root, el: "2", clicks: 800, dead: 0, dead_int: 0 },
        { root, el: "3", clicks: 50, dead: 0, dead_int: 0 },
        { root, el: "4", clicks: 600, dead: 300, dead_int: 300 },
        {
          root: "site/sections/VWO.tsx#0",
          el: "5",
          clicks: 99999,
          dead: 0,
        },
      ],
      hmFunnel: [
        { root: "", el: "0", visitors: 1000, viewed: 500, carted: 50 },
        { root, el: "4", visitors: 400, viewed: 300, carted: 120 },
      ],
    },
  } as unknown as HeatmapPayload;

  test("mais clicados + morto em clicável, sem seção que não é conteúdo", () => {
    const els = pickElements(payload) ?? [];
    expect(els.map((e) => e.el)).toEqual(["1", "2", "4", "3"]);
    expect(els[0]?.section).toBe("Product/ProductInfo");
    expect(els.find((e) => e.el === "4")?.funnel).toEqual({
      visitors: 400,
      carted: 120,
    });
    expect(els.find((e) => e.el === "1")?.funnel).toBeNull();
  });
});

describe("pickCaptureTargets", () => {
  const row = (
    id: string,
    views: number,
    availability: ProductRow["availability"],
    available = 5,
  ): ProductRow => ({
    product_id: id,
    name: id,
    url: `https://loja.com/${id}/p`,
    views,
    orders: 0,
    orders_per_1k_views: 0,
    availability,
    available_skus: available,
    total_skus: 5,
  });

  // 12/11: a "mais vista à venda" tinha 1 de 5 tamanhos.
  test("o print principal é o mais visto com a grade inteira; o de falta vem marcado", () => {
    const out = pickCaptureTargets(
      [
        row("quebrada", 19000, "broken_grid", 1),
        row("quase", 17000, "alive", 3),
        row("inteira", 15000, "alive", 5),
      ],
      "loja.com",
    );
    expect(out.map((t) => [t.product_id, t.stock])).toEqual([
      ["inteira", "alive"],
      ["quebrada", "broken_grid"],
    ]);
  });

  test("sem grade inteira, a mais vista à venda", () => {
    const out = pickCaptureTargets(
      [row("esgotado", 9, "sold_out", 0), row("quase", 5, "alive", 3)],
      "loja.com",
    );
    expect(out.map((t) => t.product_id)).toEqual(["quase", "esgotado"]);
  });
});

describe("buildFunnelSegmentsQuery", () => {
  const now = new Date("2026-11-15T12:00:00Z");

  test("uma leitura com os quatro recortes, só colunas estreitas", () => {
    const sql = buildFunnelSegmentsQuery(
      "example-project",
      "analytics_1",
      7,
      now,
    );
    expect(sql).toContain("GROUPING SETS");
    expect(sql).toContain("(platform, channel, event_name)");
    expect(sql).toContain("(platform, visitor, event_name)");
    expect(sql).toContain("(platform, event_date, event_name)");
    expect(sql).not.toContain("event_params");
    expect(sql).toContain("BETWEEN '20261108' AND '20261114'");
    // "nova" = primeiro toque a partir do início da janela.
    expect(sql).toContain("TIMESTAMP('2026-11-08')");
  });

  test("recusa identificador com SQL", () => {
    expect(() => buildFunnelSegmentsQuery("p; DROP", "d", 7)).toThrow();
  });
});

describe("toFunnelSegments", () => {
  const row = (over: Record<string, unknown>, g: [number, number, number]) => ({
    platform: "web_mobile",
    event_name: "view_item",
    users: 10,
    g_channel: g[0],
    g_visitor: g[1],
    g_day: g[2],
    ...over,
  });

  test("a linha sem recorte é o funil; as outras viram recortes", () => {
    const out = toFunnelSegments([
      row({ users: 100 }, [1, 1, 1]),
      row({ event_name: "add_to_cart", users: 10 }, [1, 1, 1]),
      row({ channel: "social_pago", users: 60 }, [0, 1, 1]),
      row({ visitor: "nova", users: 70 }, [1, 0, 1]),
      row({ event_date: "20261110", users: 15 }, [1, 1, 0]),
      // String "1" (é como o BigQuery devolve INT64).
      row(
        { channel: "direto", users: 5, g_visitor: "1", g_day: "1" },
        [0, 1, 1],
      ),
    ]);
    expect(out.platform_funnel).toHaveLength(1);
    expect(
      out.platform_funnel[0]?.steps.find((s) => s.event === "view_item")?.count,
    ).toBe(100);
    expect(out.segments.map((s) => `${s.dim}:${s.key}`)).toEqual([
      "canal:direto",
      "canal:social_pago",
      "dia:20261110",
      "visitante:nova",
    ]);
  });
});

describe("curva de rolagem", () => {
  test("21 pontos de 5 em 5%", () => {
    const b = toDeviceBehaviour("mobile", heatmap);
    expect(b?.scroll_curve).toHaveLength(21);
    expect(b?.scroll_curve?.[0]).toEqual({ depth: 0, reach_pct: 100 });
    expect(b?.scroll_curve?.[10]?.reach_pct).toBe(b?.reach.p50);
  });
});

describe("funil zerado do Deco Analytics (16/11)", () => {
  test("sem 'viu produto' nem 'carrinho' em ninguém: sem funil, também nos elementos", () => {
    const raw = heatmap;
    const zeroed: HeatmapPayload = {
      ...raw,
      data: {
        ...raw.data,
        hmFunnel: (raw.data.hmFunnel ?? []).map((r) => ({
          ...r,
          viewed: 0,
          carted: 0,
        })),
      },
    };
    const b = toDeviceBehaviour("mobile", zeroed);
    expect(b?.funnel).toBeNull();
    expect((b?.elements ?? []).every((e) => e.funnel === null)).toBe(true);
    // O payload de verdade continua com funil.
    expect(toDeviceBehaviour("mobile", raw)?.funnel).not.toBeNull();
  });
});

describe("collectEvidence sem domínio nem credenciais VTEX", () => {
  test("no VTEX access → run starts and no credentials gap is raised", async () => {
    const out = await collectEvidence({
      profile: { domain: "a.example" } as SiteProfile,
      pageType: "pdp",
      orgSlug: "org-a",
      heatmap: unregistered,
      lake: noLake,
      bigquery: null,
      vtex: null,
      fetch: offline,
    });
    expect(
      out.evidence.gaps.some((g) => g.error.includes("credenciais VTEX")),
    ).toBe(false);
  });
});

describe("collectEvidence marca de quem é cada lacuna", () => {
  test("Analytics, GA4 e pedidos são do cliente; o catálogo público é de fora", async () => {
    const notFound = (async () =>
      new Response("não achei", { status: 404 })) as unknown as typeof fetch;
    // O funil esbarra em permissão; os produtos vistos vêm.
    const bigquery = {
      run: async (args: Record<string, unknown>) => {
        if (String(args.query ?? "").includes("AS product_id")) {
          return { rows: [{ product_id: "123", views: 10 }] };
        }
        throw new Error(
          "Access Denied: Table projeto:analytics_1.events_20261120: User does not have permission",
        );
      },
      projectId: "projeto",
      datasetId: "analytics_1",
    };
    const out = await collectEvidence({
      profile: {
        domain: "loja.example",
        studio_site: null,
        pdp_path_template: "/:slug/p",
      } as SiteProfile,
      pageType: "pdp",
      orgSlug: "org-a",
      heatmap: unregistered,
      lake: noLake,
      bigquery,
      vtex: { publicHost: "loja.example" },
      fetch: notFound,
    });
    const byKey = (s: string) =>
      out.evidence.gaps.find((g) => g.error.startsWith(s));
    expect(byKey('o site "org-a" não está registrado')).toMatchObject({
      source: "heatmap",
      key: "analytics_install",
      owner: "customer",
    });
    expect(byKey("recortes do funil")).toMatchObject({
      source: "bigquery",
      key: "bigquery",
      owner: "customer",
    });
    expect(byKey("funil por plataforma")).toMatchObject({
      source: "bigquery",
      key: "bigquery",
      owner: "customer",
    });
    expect(byKey("receita por canal")).toEqual({
      source: "lake",
      error: "receita por canal: nenhum pedido pago nos últimos 28 dias",
      key: "orders",
      owner: "customer",
    });
    const vtex = byKey("produtos:");
    expect(vtex?.owner).toBe("external");
    expect(vtex?.key).toBeUndefined();
  });
});

describe("isBigQuerySetupError", () => {
  test("dataset que não existe ou acesso negado é do cliente", () => {
    expect(
      isBigQuerySetupError(
        "Not found: Dataset projeto:analytics_1 was not found in location US",
      ),
    ).toBe(true);
    expect(
      isBigQuerySetupError(
        "Access Denied: Project projeto: User does not have bigquery.jobs.create permission",
      ),
    ).toBe(true);
    expect(isBigQuerySetupError("bigquery_query: HTTP 403 Forbidden")).toBe(
      true,
    );
  });

  test("queda passageira é nossa", () => {
    expect(isBigQuerySetupError("The operation timed out.")).toBe(false);
    expect(
      isBigQuerySetupError("bigquery_query: HTTP 500 Internal Server Error"),
    ).toBe(false);
    expect(
      isBigQuerySetupError("a consulta não trouxe o funil sem recorte"),
    ).toBe(false);
  });
});

describe("collectEvidence com o lake fora do ar", () => {
  test("timeout no lake é lacuna nossa, não pede pedidos ao cliente", async () => {
    const out = await collectEvidence({
      profile: { domain: "a.example" } as SiteProfile,
      pageType: "carrinho_checkout",
      orgSlug: "org-a",
      heatmap: async () => ({ registered: true, siteId: null, data: {} }),
      lake: async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
      bigquery: null,
      vtex: null,
      fetch: offline,
    });
    const lake = out.evidence.gaps.find((g) => g.source === "lake");
    expect(lake?.error).toStartWith("receita por canal:");
    expect(lake?.error).toContain("timed out");
    expect(lake?.key).toBeUndefined();
    expect(lake?.owner).toBeUndefined();
  });
});
