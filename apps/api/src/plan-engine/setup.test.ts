import { describe, expect, test } from "bun:test";
import { buildSetup, gapDetail } from "./setup.ts";
import type { SiteProfile, SourceGap } from "./types.ts";

const profile = (over: Partial<SiteProfile> = {}): SiteProfile => ({
  domain: "www.loja.example",
  studio_site: null,
  pdp_path_template: "/:slug/p",
  competitors: ["concorrente.example", "outra.example"],
  competitors_confirmed_at: "2026-11-20T00:00:00.000Z",
  design_system: null,
  design_system_at: null,
  code_tokens: null,
  sources: null,
  code_repo: null,
  code_project_id: null,
  updated_at: "2026-11-20T00:00:00.000Z",
  ...over,
});

const analytics: SourceGap = {
  source: "heatmap",
  error: 'o site "loja" não está registrado no Deco Analytics',
  key: "analytics_install",
  owner: "customer",
};
const orders: SourceGap = {
  source: "lake",
  error: "receita por canal: nenhum pedido",
  key: "orders",
  owner: "customer",
};
const repository: SourceGap = {
  source: "github",
  error:
    "código indisponível: o projeto do site no Studio não tem repositório ligado",
  owner: "customer",
  key: "repository",
};
const bigquery: SourceGap = {
  source: "bigquery",
  error: "funil por plataforma: acesso negado",
  key: "bigquery",
  owner: "customer",
};

describe("buildSetup", () => {
  test("no profile asks only for the domain, and it blocks", () => {
    expect(buildSetup(null, [analytics, orders])).toEqual({
      needs: [{ key: "domain", blocking: true, suggested: null }],
      current: { domain: null, competitors: [] },
    });
  });

  test("unconfirmed competitors are suggested, not blocking", () => {
    const p = profile({ competitors_confirmed_at: null });
    expect(buildSetup(p, [])).toEqual({
      needs: [
        {
          key: "competitors",
          blocking: false,
          suggested: ["concorrente.example", "outra.example"],
        },
      ],
      current: {
        domain: "www.loja.example",
        competitors: ["concorrente.example", "outra.example"],
      },
    });
  });

  test("confirmed competitors and no customer gap need nothing", () => {
    expect(buildSetup(profile(), []).needs).toEqual([]);
  });

  test("one need per customer gap key, in key order", () => {
    const needs = buildSetup(profile({ competitors_confirmed_at: null }), [
      orders,
      bigquery,
      analytics,
    ]).needs;
    expect(needs.map((n) => n.key)).toEqual([
      "competitors",
      "analytics_install",
      "bigquery",
      "orders",
    ]);
    expect(needs.slice(1).every((n) => n.blocking === false)).toBe(true);
  });

  test("a repository the customer must link comes last, after the data sources", () => {
    const needs = buildSetup(profile(), [repository, orders, analytics]).needs;
    expect(needs).toEqual([
      { key: "analytics_install", blocking: false },
      { key: "orders", blocking: false },
      { key: "repository", blocking: false },
    ]);
  });

  test("a code gap that is ours gives no need for the customer", () => {
    const ours: SourceGap = { source: "github", error: "código indisponível" };
    expect(buildSetup(profile(), [ours]).needs).toEqual([]);
  });

  test("two pages with the same customer gap give one need", () => {
    const needs = buildSetup(profile(), [analytics, analytics]).needs;
    expect(needs).toEqual([{ key: "analytics_install", blocking: false }]);
  });

  test("gaps that are not the customer's give no need", () => {
    const gaps: SourceGap[] = [
      { source: "heatmap", error: "sem coleta" },
      { source: "vtex", error: "produtos: 503", owner: "external" },
      { source: "bigquery", error: "x", key: "bigquery", owner: "ours" },
    ];
    expect(buildSetup(profile(), gaps).needs).toEqual([]);
  });
});

describe("buildSetup without an AI model", () => {
  const lostModel: SourceGap = {
    source: "studio",
    error: "nenhum modelo de IA conectado",
    owner: "customer",
    key: "ai_provider",
  };

  test("asks for a provider first, and it blocks", () => {
    const needs = buildSetup(
      profile({ competitors_confirmed_at: null }),
      [analytics],
      false,
    ).needs;
    expect(needs.map((n) => n.key)).toEqual([
      "ai_provider",
      "competitors",
      "analytics_install",
    ]);
    expect(needs[0]).toEqual({ key: "ai_provider", blocking: true });
  });

  test("no profile asks for the domain, then the provider", () => {
    expect(buildSetup(null, [], false).needs).toEqual([
      { key: "domain", blocking: true, suggested: null },
      { key: "ai_provider", blocking: true },
    ]);
  });

  test("a run's lost-model gap asks nothing once the org has a model again", () => {
    expect(buildSetup(profile(), [lostModel]).needs).toEqual([]);
    expect(buildSetup(profile(), [lostModel, lostModel], false).needs).toEqual([
      { key: "ai_provider", blocking: true },
    ]);
  });
});

describe("gapDetail", () => {
  test("an untagged gap is ours", () => {
    expect(gapDetail({ source: "heatmap", error: "sem coleta" })).toEqual({
      source: "heatmap",
      owner: "ours",
      message: "Deco Analytics: sem coleta",
    });
  });

  test("a tagged gap keeps its key and owner, with the same message as gaps", () => {
    expect(gapDetail(analytics)).toEqual({
      source: "heatmap",
      owner: "customer",
      key: "analytics_install",
      message:
        'Deco Analytics: o site "loja" não está registrado no Deco Analytics',
    });
    expect(gapDetail(repository)).toEqual({
      source: "github",
      owner: "customer",
      key: "repository",
      message:
        "Código: código indisponível: o projeto do site no Studio não tem repositório ligado",
    });
    expect(gapDetail(orders).message).toBe(
      "VTEX (pedidos): receita por canal: nenhum pedido",
    );
  });
});
