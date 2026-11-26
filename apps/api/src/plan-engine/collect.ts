/**
 * Coleta: os números que a análise manual juntou à mão pra `pdp-oportunidades`.
 *
 *   - funil por plataforma (web no celular, web no computador, app) — GA4 via
 *     BigQuery, por USUÁRIA (o método dos analistas: uma pessoa pode levar
 *     três sessões pra comprar);
 *   - comportamento na PDP por dispositivo — Deco Analytics (rolagem, dobra,
 *     cliques mortos, funil da página, alcance por seção);
 *   - receita por canal de venda — lake (pedidos VTEX), base da conta do dinheiro;
 *   - produtos muito vistos que não vendem, cruzados com o estoque ao vivo — a
 *     fila de PDPs do relatório.
 *
 * Cada fonte é independente: a que falhar vira um `SourceGap` e o diagnóstico
 * segue com as outras. Uma análise com um buraco nomeado vale mais que nenhuma.
 *
 * Custo: o GA4 de uma loja grande é grande, e a cota diária é dividida. Aqui
 * só entram colunas estreitas (event_name, platform, device.category,
 * user_pseudo_id e items.item_id) em 7 dias — ordem de 10 GB, contra os ~290 GB
 * do funil completo com event_params.
 */

import { delay } from "@decocms/shared/std";
import { type BigQueryScan, callBigQuery, fetchPdpViews } from "./bigquery.ts";
import { GA4_METRIC_EVENTS } from "./metrics.ts";
import { siteChannel } from "./money.ts";
import {
  detectPageTemplates,
  heatmapRouteFor,
  type PageRoute,
  routesFromPages,
  templatesAreStale,
} from "./page-templates.ts";
import type {
  BigQueryRunner,
  HeatmapPayload,
  HeatmapReader,
  LakeQuery,
} from "./ports.ts";
import type {
  DevicePdpBehaviour,
  DiagnosisEvidence,
  FunnelSegment,
  Ga4PageFunnel,
  PageTemplates,
  PlatformFunnel,
  ProductSignal,
  RevenueBase,
  SegmentDim,
  SiteProfile,
  SourceGap,
  UxDevice,
  UxPageType,
} from "./types.ts";
import {
  readAvailability,
  type VtexAccess,
  type VtexCatalogSearchProduct,
  vtexSearchByProductIds,
} from "./vtex.ts";

/** Janela padrão. Uma semana pega o ciclo de lançamento (quarta) inteiro. */
const WINDOW_DAYS = 7;

/** Quantos produtos mais vistos entram no cruzamento com o estoque. */
const TOP_VIEWED = 40;

export interface CollectInput {
  profile: SiteProfile;
  /** A página analisada. Ausente = PDP (o diagnóstico de antes de 16/11). */
  pageType?: UxPageType;
  /** O site do Deco Analytics quando o perfil não diz qual (o slug da org). */
  orgSlug: string;
  heatmap: HeatmapReader;
  lake: LakeQuery;
  bigquery: {
    run: BigQueryRunner;
    projectId: string;
    datasetId: string;
  } | null;
  /** Null só quando o domínio da loja não é conhecido. */
  vtex: VtexAccess | null;
  onScan?: (scan: BigQueryScan) => void;
  /** O catálogo público e a busca da loja. Ausente = o `fetch` global. */
  fetch?: typeof fetch;
}

/** Uma página pra abrir no navegador, com o motivo de ter sido escolhida. */
export interface CaptureCandidate {
  url: string;
  /** O produto da PDP. Vazio = não é PDP (ou é a home de último recurso). */
  product_id: string;
  why: string;
  stock: ProductSignal["availability"] | null;
}

export interface CollectResult {
  evidence: Omit<DiagnosisEvidence, "captures" | "benchmark">;
  capture_targets: CaptureCandidate[];
  /** Rotas lidas de novo do `hmPages` nesta coleta; o chamador grava no perfil. */
  page_templates?: PageTemplates;
}

export async function collectEvidence(
  input: CollectInput,
): Promise<CollectResult> {
  const gaps: SourceGap[] = [];
  const site = input.profile.studio_site || input.orgSlug;
  const pageType = input.pageType ?? "pdp";

  // Rotas de home, busca e categoria, do `hmPages` quando faltam ou estão velhas.
  let templates = input.profile.page_templates ?? null;
  let freshTemplates: PageTemplates | undefined;
  let siteRoutes: PageRoute[] = [];
  if (pageType !== "pdp" && pageType !== "carrinho_checkout") {
    try {
      const probe = await input.heatmap(site, {
        page: "/",
        device: "mobile",
        range: "7d",
      });
      siteRoutes = routesFromPages(probe.data.hmPages ?? []);
      if (templatesAreStale(templates) && siteRoutes.length > 0) {
        freshTemplates = detectPageTemplates(
          siteRoutes,
          input.profile.pdp_path_template,
          new Date().toISOString(),
        );
        templates = freshTemplates;
      }
    } catch (err) {
      gaps.push({
        source: "heatmap",
        error: `rotas do site (hmPages): ${errText(err)}`,
      });
    }
  }
  // Sem rota ou funil no Deco Analytics, o funil da página vem do GA4 (no máximo uma consulta).
  const usesGa4Pages =
    input.bigquery !== null &&
    (pageType === "home" || pageType === "busca" || pageType === "categoria");
  let ga4Pages: Ga4PageRow[] | null = null;
  const loadGa4Pages = async (): Promise<Ga4PageRow[]> => {
    if (ga4Pages) return ga4Pages;
    try {
      ga4Pages = await fetchGa4Pages(
        input.bigquery as NonNullable<CollectInput["bigquery"]>,
        input.onScan,
      );
    } catch (err) {
      gaps.push({
        source: "bigquery",
        error: `funil por página: ${errText(err)}`,
        ...bigQueryGapOwner(err),
      });
      ga4Pages = [];
    }
    return ga4Pages;
  };
  let route =
    pageType === "carrinho_checkout"
      ? null
      : heatmapRouteFor(pageType, input.profile.pdp_path_template, templates);
  if (!route && usesGa4Pages) {
    const fromGa4 = detectPageTemplates(
      ga4ListingRoutes(await loadGa4Pages(), input.profile.pdp_path_template),
      input.profile.pdp_path_template,
      new Date().toISOString(),
    );
    templates = {
      home: templates?.home ?? fromGa4.home,
      busca: templates?.busca ?? fromGa4.busca,
      categoria: templates?.categoria.length
        ? templates.categoria
        : fromGa4.categoria,
      detected_at: templates?.detected_at ?? fromGa4.detected_at,
    };
    route = heatmapRouteFor(
      pageType,
      input.profile.pdp_path_template,
      templates,
    );
  }
  if (!route && pageType !== "carrinho_checkout") {
    gaps.push({
      source: "heatmap",
      error: usesGa4Pages
        ? `não achei a rota de ${pageType} no Deco Analytics nem no GA4`
        : `não achei a rota de ${pageType} no Deco Analytics`,
    });
  }

  const noFunnel = { platform_funnel: [] as PlatformFunnel[], segments: [] };
  const [funnel, behaviour, revenue] = await Promise.all([
    input.bigquery
      ? fetchFunnelWithSegments(input.bigquery, gaps, input.onScan).catch(
          (err) => {
            gaps.push({
              source: "bigquery",
              error: `funil por plataforma: ${errText(err)}`,
              ...bigQueryGapOwner(err),
            });
            return noFunnel;
          },
        )
      : Promise.resolve(noFunnel),
    route
      ? fetchPageBehaviour(input.heatmap, site, route, gaps).catch((err) => {
          gaps.push({
            source: "heatmap",
            error: errText(err),
            ...(err instanceof AnalyticsNotInstalled
              ? {
                  key: "analytics_install" as const,
                  owner: "customer" as const,
                }
              : {}),
          });
          return [] as DevicePdpBehaviour[];
        })
      : Promise.resolve([] as DevicePdpBehaviour[]),
    fetchRevenueBase(input.lake).catch((err) => {
      gaps.push({
        source: "lake",
        error: `receita por canal: ${errText(err)}`,
        ...(err instanceof NoPaidOrders
          ? { key: "orders" as const, owner: "customer" as const }
          : {}),
      });
      return null;
    }),
  ]);
  if (!input.bigquery) {
    gaps.push({ source: "bigquery", error: "BigQuery não configurado na app" });
  }

  // Produtos vistos x estoque só servem à PDP (a fila de PDPs e a página a abrir).
  let products: ProductSignal[] = [];
  let viewed: ProductRow[] = [];
  if (pageType === "pdp" && input.bigquery && input.vtex) {
    try {
      ({ signals: products, rows: viewed } = await fetchProductSignals(
        input,
        revenue,
      ));
    } catch (err) {
      gaps.push({
        source: "vtex",
        error: `produtos: ${errText(err)}`,
        // O catálogo é o público da loja: ninguém aqui o conserta.
        owner: "external" as const,
      });
    }
  }

  let ga4PageFunnel: Ga4PageFunnel | null = null;
  if (usesGa4Pages && route && !hasPageFunnel(behaviour)) {
    ga4PageFunnel = ga4FunnelFor(await loadGa4Pages(), route);
    if (!ga4PageFunnel && behaviour.length > 0) {
      gaps.push({
        source: "heatmap",
        error: `a página ${route} não tem funil: o Deco Analytics não recebe os eventos de produto e carrinho dela, e o GA4 não tem a rota`,
      });
    }
  }

  const routes = routesOfType(pageType, siteRoutes, templates, route);
  let searchTerm: string | null = null;
  if (pageType === "busca") {
    searchTerm = await topSearchTerm(
      input.profile.domain,
      input.fetch ?? fetch,
    ).catch(() => null);
    searchTerm ??= termFromRoutes(templates?.categoria ?? []);
  }

  return {
    evidence: {
      window_days: WINDOW_DAYS,
      platform_funnel: funnel.platform_funnel,
      segments: funnel.segments,
      pdp_behaviour: behaviour,
      revenue,
      products,
      gaps,
      page_type: pageType,
      page_route: route,
      ...(routes.length > 0 ? { routes } : {}),
      ...(searchTerm ? { search_term: searchTerm } : {}),
      ...(ga4PageFunnel ? { ga4_page_funnel: ga4PageFunnel } : {}),
    },
    capture_targets:
      pageType === "pdp"
        ? pickCaptureTargets(viewed, input.profile.domain)
        : pageCaptureTargets(pageType, input.profile.domain, route, searchTerm),
    ...(freshTemplates ? { page_templates: freshTemplates } : {}),
  };
}

/** As rotas deste tipo de página com o tráfego delas (resumo pro prompt). */
function routesOfType(
  pageType: UxPageType,
  siteRoutes: PageRoute[],
  templates: PageTemplates | null,
  route: string | null,
): PageRoute[] {
  const pages =
    pageType === "categoria"
      ? (templates?.categoria ?? [])
      : route
        ? [route]
        : [];
  const by = new Map(siteRoutes.map((r) => [r.page, r]));
  return pages.flatMap((p) => {
    const r = by.get(p);
    return r ? [r] : [];
  });
}

/** O termo mais buscado no Intelligent Search da VTEX (endpoint público da loja). */
async function topSearchTerm(
  domain: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const res = await fetchImpl(
    `https://${domain}/api/io/_v/api/intelligent-search/top_searches`,
    { signal: AbortSignal.timeout(8_000) },
  );
  if (!res.ok) return null;
  const body = (await res.json()) as {
    searches?: Array<{ term?: string }>;
  };
  const term = body.searches?.find((s) => s.term?.trim())?.term?.trim();
  return term || null;
}

/**
 * Sem Intelligent Search (16/11, `searches: []`), um termo que a
 * loja vende: o último pedaço da categoria mais vista que é uma palavra só
 * (`/produtos/vestido` → "vestido"; `/joias/aneis` → "aneis").
 */
function termFromRoutes(categoryRoutes: string[]): string | null {
  for (const r of categoryRoutes) {
    const seg = r.split("/").filter(Boolean).pop();
    if (seg && /^[a-zà-ú]{3,}$/i.test(seg)) return seg.toLowerCase();
  }
  return null;
}

/** A página a abrir fora da PDP: a rota do heatmap no domínio da loja. */
function pageCaptureTargets(
  pageType: UxPageType,
  domain: string,
  route: string | null,
  searchTerm: string | null,
): CaptureCandidate[] {
  if (pageType === "carrinho_checkout") return [];
  if (pageType === "home") {
    return [
      { url: `https://${domain}/`, product_id: "", why: "a home", stock: null },
    ];
  }
  if (!route) return [];
  if (pageType === "busca") {
    if (!searchTerm) return [];
    return [
      {
        url: `https://${domain}${route}?q=${encodeURIComponent(searchTerm)}`,
        product_id: "",
        why: `a busca por "${searchTerm}" (o termo mais buscado)`,
        stock: null,
      },
    ];
  }
  return [
    {
      url: `https://${domain}${route}`,
      product_id: "",
      why: `a categoria mais vista (${route})`,
      stock: null,
    },
  ];
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Funil por plataforma (GA4 / BigQuery) ────────────────────────────────────

/**
 * Os eventos do funil: os de sempre e os das outras páginas (vitrine, banner,
 * etapas do checkout). Mais nomes no IN não custa mais: o GA4 cobra por
 * coluna lida, e as colunas são as mesmas.
 */
const FUNNEL_EVENTS: readonly string[] = [
  ...new Set([
    "session_start",
    "view_item",
    "add_to_cart",
    "begin_checkout",
    "purchase",
    ...GA4_METRIC_EVENTS,
  ]),
];

const GA4_IDENTIFIER = /^[A-Za-z0-9_-]+$/;

function ga4Suffix(daysAgo: number, now = new Date()): string {
  return new Date(now.getTime() - daysAgo * 86_400_000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");
}

/**
 * Usuárias distintas por evento, por plataforma × dispositivo. Funil ABERTO
 * (fez o evento na janela, não necessariamente na ordem) — o mesmo "indireto"
 * do GA4 que os analistas usam; ordenar no tempo exigiria event_params e
 * multiplicaria o custo.
 */
export function buildPlatformFunnelQuery(
  projectId: string,
  datasetId: string,
  days: number,
  now = new Date(),
): string {
  if (!GA4_IDENTIFIER.test(projectId) || !GA4_IDENTIFIER.test(datasetId)) {
    throw new Error(`invalid GA4 project/dataset: ${projectId}.${datasetId}`);
  }
  return `
SELECT
  CASE
    WHEN platform = 'WEB' AND device.category = 'desktop' THEN 'web_desktop'
    WHEN platform = 'WEB' THEN 'web_mobile'
    WHEN platform = 'IOS' THEN 'app_ios'
    WHEN platform = 'ANDROID' THEN 'app_android'
    ELSE LOWER(platform)
  END AS platform,
  event_name,
  COUNT(DISTINCT user_pseudo_id) AS users
FROM \`${projectId}.${datasetId}.events_*\`
WHERE _TABLE_SUFFIX BETWEEN '${ga4Suffix(days, now)}' AND '${ga4Suffix(1, now)}'
  AND event_name IN (${FUNNEL_EVENTS.map((e) => `'${e}'`).join(", ")})
GROUP BY platform, event_name
`;
}

/**
 * Canal de aquisição da usuária, pelo PRIMEIRO toque (traffic_source do export
 * do GA4 é da aquisição da usuária, não da sessão). É o que deixa ver se a
 * diferença entre celular e computador é a página ou o tráfego: campanha de
 * aquisição cai mais no celular, e gente nova converte menos em qualquer tela.
 */
const CHANNEL_SQL = `CASE
      WHEN REGEXP_CONTAINS(LOWER(IFNULL(traffic_source.medium, '')), r'cpc|ppc|paid|cpm|cpv|ads|display')
        AND REGEXP_CONTAINS(LOWER(IFNULL(traffic_source.source, '')), r'facebook|instagram|meta|^fb|^ig|tiktok|pinterest|snapchat|kwai')
        THEN 'social_pago'
      WHEN REGEXP_CONTAINS(LOWER(IFNULL(traffic_source.medium, '')), r'cpc|ppc|paid|cpm|cpv|ads|display')
        THEN 'midia_paga'
      WHEN LOWER(IFNULL(traffic_source.medium, '')) = 'organic' THEN 'busca_organica'
      WHEN REGEXP_CONTAINS(LOWER(IFNULL(traffic_source.medium, '')), r'social')
        OR REGEXP_CONTAINS(LOWER(IFNULL(traffic_source.source, '')), r'facebook|instagram|tiktok|pinterest|linktr|t\\.co|twitter|youtube')
        THEN 'social'
      WHEN REGEXP_CONTAINS(LOWER(IFNULL(traffic_source.medium, '')), r'e-?mail|crm|sms|push|whats|newsletter')
        THEN 'crm'
      WHEN traffic_source.source = '(direct)' OR traffic_source.medium IN ('(none)', '(not set)') THEN 'direto'
      WHEN LOWER(IFNULL(traffic_source.medium, '')) = 'referral' THEN 'referencia'
      ELSE 'outros'
    END`;

/**
 * O funil por plataforma E os recortes dele, numa leitura só da tabela. Cada
 * GROUPING SET é um recorte: o funil inteiro (o de antes), por canal de
 * aquisição, por usuária nova × recorrente (primeiro toque dentro da janela =
 * nova; cookie apagado também parece nova) e por dia. Só colunas estreitas —
 * nada de event_params, que é o que encarece o GA4.
 */
export function buildFunnelSegmentsQuery(
  projectId: string,
  datasetId: string,
  days: number,
  now = new Date(),
): string {
  if (!GA4_IDENTIFIER.test(projectId) || !GA4_IDENTIFIER.test(datasetId)) {
    throw new Error(`invalid GA4 project/dataset: ${projectId}.${datasetId}`);
  }
  const start = ga4Suffix(days, now);
  const startDate = `${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6, 8)}`;
  return `
WITH e AS (
  SELECT
    CASE
      WHEN platform = 'WEB' AND device.category = 'desktop' THEN 'web_desktop'
      WHEN platform = 'WEB' THEN 'web_mobile'
      WHEN platform = 'IOS' THEN 'app_ios'
      WHEN platform = 'ANDROID' THEN 'app_android'
      ELSE LOWER(platform)
    END AS platform,
    event_name,
    event_date,
    user_pseudo_id,
    ${CHANNEL_SQL} AS channel,
    CASE
      WHEN user_first_touch_timestamp IS NULL THEN 'sem_dado'
      WHEN user_first_touch_timestamp >= UNIX_MICROS(TIMESTAMP('${startDate}')) THEN 'nova'
      ELSE 'recorrente'
    END AS visitor
  FROM \`${projectId}.${datasetId}.events_*\`
  WHERE _TABLE_SUFFIX BETWEEN '${start}' AND '${ga4Suffix(1, now)}'
    AND event_name IN (${FUNNEL_EVENTS.map((e) => `'${e}'`).join(", ")})
)
SELECT
  platform, event_name, channel, visitor, event_date,
  GROUPING(channel) AS g_channel,
  GROUPING(visitor) AS g_visitor,
  GROUPING(event_date) AS g_day,
  COUNT(DISTINCT user_pseudo_id) AS users
FROM e
GROUP BY GROUPING SETS (
  (platform, event_name),
  (platform, channel, event_name),
  (platform, visitor, event_name),
  (platform, event_date, event_name)
)
`;
}

/**
 * Linhas da consulta de recortes → o funil por plataforma (a linha sem
 * recorte) e os recortes. Exportado pra teste.
 */
export function toFunnelSegments(
  rows: ReadonlyArray<Record<string, unknown>>,
): {
  platform_funnel: PlatformFunnel[];
  segments: FunnelSegment[];
} {
  const flag = (v: unknown) => Number(v ?? 0) === 1;
  const base: Array<Record<string, unknown>> = [];
  const byKey = new Map<
    string,
    {
      dim: SegmentDim;
      key: string;
      platform: string;
      events: Map<string, number>;
    }
  >();
  for (const row of rows) {
    const gChannel = flag(row.g_channel);
    const gVisitor = flag(row.g_visitor);
    const gDay = flag(row.g_day);
    if (gChannel && gVisitor && gDay) {
      base.push(row);
      continue;
    }
    const dim: SegmentDim | null = !gChannel
      ? "canal"
      : !gVisitor
        ? "visitante"
        : !gDay
          ? "dia"
          : null;
    if (!dim) continue;
    const key = String(
      dim === "canal"
        ? row.channel
        : dim === "visitante"
          ? row.visitor
          : row.event_date,
    );
    const platform = String(row.platform ?? "");
    if (!platform || !key || key === "null") continue;
    const id = `${dim}|${key}|${platform}`;
    const entry = byKey.get(id) ?? { dim, key, platform, events: new Map() };
    entry.events.set(String(row.event_name ?? ""), Number(row.users ?? 0));
    byKey.set(id, entry);
  }
  const segments = [...byKey.values()]
    .map((s) => ({
      dim: s.dim,
      key: s.key,
      platform: s.platform,
      steps: FUNNEL_EVENTS.map((event) => ({
        event,
        count: s.events.get(event) ?? 0,
      })),
    }))
    .sort((a, b) =>
      a.dim === b.dim
        ? a.platform === b.platform
          ? a.key.localeCompare(b.key)
          : a.platform.localeCompare(b.platform)
        : a.dim.localeCompare(b.dim),
    );
  return { platform_funnel: toPlatformFunnels(base), segments };
}

/**
 * O erro diz que o dataset, a tabela ou o projeto não existe, ou que a conta
 * não tem acesso: isso o cliente resolve. Timeout e 5xx são nossos.
 */
export function isBigQuerySetupError(message: string): boolean {
  return (
    /not found:\s*(dataset|table|project)/i.test(message) ||
    /access denied|permission/i.test(message) ||
    /\b(403|404)\b/.test(message)
  );
}

function bigQueryGapOwner(
  err: unknown,
): { key: "bigquery"; owner: "customer" } | Record<string, never> {
  return isBigQuerySetupError(errText(err))
    ? { key: "bigquery", owner: "customer" }
    : {};
}

/**
 * O funil com recortes; se a consulta nova falhar, o funil simples de antes
 * (o diagnóstico não pode perder o funil por causa dos recortes).
 */
async function fetchFunnelWithSegments(
  bq: NonNullable<CollectInput["bigquery"]>,
  gaps: SourceGap[],
  onScan?: (scan: BigQueryScan) => void,
): Promise<{ platform_funnel: PlatformFunnel[]; segments: FunnelSegment[] }> {
  try {
    const sql = buildFunnelSegmentsQuery(
      bq.projectId,
      bq.datasetId,
      WINDOW_DAYS,
    );
    const data = await callBigQuery(
      bq.run,
      { projectId: bq.projectId, query: sql.trim(), maxResults: 5000 },
      { label: "uxFunnelSegments", onScan },
    );
    const out = toFunnelSegments(data.rows ?? []);
    if (out.platform_funnel.length > 0) return out;
    throw new Error("a consulta não trouxe o funil sem recorte");
  } catch (err) {
    gaps.push({
      source: "bigquery",
      error: `recortes do funil (canal, nova x recorrente, dia): ${errText(err)}`,
      ...bigQueryGapOwner(err),
    });
    return {
      platform_funnel: await fetchPlatformFunnel(bq, onScan),
      segments: [],
    };
  }
}

async function fetchPlatformFunnel(
  bq: NonNullable<CollectInput["bigquery"]>,
  onScan?: (scan: BigQueryScan) => void,
): Promise<PlatformFunnel[]> {
  const sql = buildPlatformFunnelQuery(bq.projectId, bq.datasetId, WINDOW_DAYS);
  const data = await callBigQuery(
    bq.run,
    { projectId: bq.projectId, query: sql.trim(), maxResults: 1000 },
    { label: "uxPlatformFunnel", onScan },
  );
  return toPlatformFunnels(data.rows ?? []);
}

/** Linhas (plataforma, evento, usuárias) → um funil por plataforma, na ordem. */
export function toPlatformFunnels(
  rows: ReadonlyArray<Record<string, unknown>>,
): PlatformFunnel[] {
  const byPlatform = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const platform = String(row.platform ?? "");
    if (!platform) continue;
    const events = byPlatform.get(platform) ?? new Map<string, number>();
    events.set(String(row.event_name ?? ""), Number(row.users ?? 0));
    byPlatform.set(platform, events);
  }
  const order = ["web_mobile", "web_desktop", "app_ios", "app_android"];
  return Array.from(byPlatform.entries())
    .sort(
      ([a], [b]) =>
        (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) -
        (order.indexOf(b) === -1 ? 99 : order.indexOf(b)),
    )
    .map(([platform, events]) => ({
      platform,
      steps: FUNNEL_EVENTS.map((event) => ({
        event,
        count: events.get(event) ?? 0,
      })),
    }));
}

// ── Funil por página (GA4 / BigQuery) ───────────────────────────────────────

/** Rotas com menos usuárias que isto por dispositivo não entram (ruído). */
const MIN_PAGE_VISITORS = 20;
/** Quantas rotas por dispositivo a consulta devolve. */
const MAX_PAGES_PER_DEVICE = 150;

/** Uma rota do site no GA4, num dispositivo. */
export interface Ga4PageRow {
  device: UxDevice;
  /** Caminho sem query nem barra final (`/` na home). */
  path: string;
  visitors: number;
  viewed: number;
  carted: number;
}

/**
 * O funil de cada rota do site no GA4: quem teve `page_view` nela, e dessas,
 * quem viu produto e quem pôs no carrinho DEPOIS, na mesma sessão. É o funil
 * da página que o Deco Analytics daria, para lojas que não mandam a ele os
 * eventos de produto e carrinho. Só web (o app não tem rota).
 *
 * Lê `event_params` (page_location e ga_session_id), a coluna cara do GA4: só
 * roda quando o Deco Analytics não respondeu (numa loja média, ~0,8 GB
 * por dia de janela).
 */
export function buildPageFunnelQuery(
  projectId: string,
  datasetId: string,
  days: number,
  now = new Date(),
): string {
  if (!GA4_IDENTIFIER.test(projectId) || !GA4_IDENTIFIER.test(datasetId)) {
    throw new Error(`invalid GA4 project/dataset: ${projectId}.${datasetId}`);
  }
  return `
WITH ev AS (
  SELECT
    user_pseudo_id AS u,
    (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'ga_session_id') AS s,
    event_name,
    event_timestamp AS ts,
    IF(device.category = 'desktop', 'desktop', 'mobile') AS device,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_location') AS loc
  FROM \`${projectId}.${datasetId}.events_*\`
  WHERE _TABLE_SUFFIX BETWEEN '${ga4Suffix(days, now)}' AND '${ga4Suffix(1, now)}'
    AND platform = 'WEB'
    AND event_name IN ('page_view', 'view_item', 'add_to_cart')
),
sess AS (
  SELECT u, s,
    MAX(IF(event_name = 'view_item', ts, NULL)) AS last_view,
    MAX(IF(event_name = 'add_to_cart', ts, NULL)) AS last_cart
  FROM ev WHERE s IS NOT NULL GROUP BY u, s
),
pv AS (
  SELECT u, s, device,
    IFNULL(NULLIF(RTRIM(REGEXP_EXTRACT(loc, r'^[a-zA-Z]+://[^/?#]+(/[^?#]*)?'), '/'), ''), '/') AS path,
    MIN(ts) AS t
  FROM ev
  WHERE event_name = 'page_view' AND s IS NOT NULL AND loc IS NOT NULL
  GROUP BY u, s, device, path
)
SELECT pv.device, pv.path,
  COUNT(DISTINCT pv.u) AS visitors,
  COUNT(DISTINCT IF(sess.last_view >= pv.t, pv.u, NULL)) AS viewed,
  COUNT(DISTINCT IF(sess.last_cart >= pv.t, pv.u, NULL)) AS carted
FROM pv JOIN sess USING (u, s)
GROUP BY pv.device, pv.path
HAVING visitors >= ${MIN_PAGE_VISITORS}
QUALIFY ROW_NUMBER() OVER (PARTITION BY pv.device ORDER BY visitors DESC) <= ${MAX_PAGES_PER_DEVICE}
`;
}

/** Linhas da consulta → rotas por dispositivo; linha malformada fica de fora. */
export function toGa4PageRows(
  rows: ReadonlyArray<Record<string, unknown>>,
): Ga4PageRow[] {
  return rows.flatMap((r) => {
    const device =
      r.device === "desktop"
        ? "desktop"
        : r.device === "mobile"
          ? "mobile"
          : null;
    const path = typeof r.path === "string" ? r.path : "";
    const visitors = Number(r.visitors ?? 0);
    const viewed = Number(r.viewed ?? 0);
    const carted = Number(r.carted ?? 0);
    if (!device || !path.startsWith("/") || !(visitors > 0)) return [];
    if (![viewed, carted].every((n) => Number.isFinite(n) && n >= 0)) return [];
    return [{ device, path, visitors, viewed, carted }];
  });
}

async function fetchGa4Pages(
  bq: NonNullable<CollectInput["bigquery"]>,
  onScan?: (scan: BigQueryScan) => void,
): Promise<Ga4PageRow[]> {
  const sql = buildPageFunnelQuery(bq.projectId, bq.datasetId, WINDOW_DAYS);
  const data = await callBigQuery(
    bq.run,
    { projectId: bq.projectId, query: sql.trim(), maxResults: 1000 },
    { label: "uxPageFunnel", onScan },
  );
  return toGa4PageRows(data.rows ?? []);
}

/** `/:product/p` → regex que casa as rotas concretas desse template. */
function templateRegex(template: string): RegExp | null {
  if (!template.includes("/:")) return null;
  const body = template
    .split("/")
    .map((seg) =>
      seg.startsWith(":")
        ? "[^/]+"
        : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("/");
  return new RegExp(`^${body}/?$`);
}

/**
 * As rotas do GA4 no formato das do `hmPages` (views = usuárias somadas nos
 * dispositivos), sem as páginas de produto: o GA4 tem uma rota por produto,
 * e o `detectPageTemplates` só sabe tirar o template.
 */
export function ga4ListingRoutes(
  rows: readonly Ga4PageRow[],
  pdpTemplate: string,
): PageRoute[] {
  const pdp = templateRegex(pdpTemplate);
  const by = new Map<string, number>();
  for (const r of rows) {
    if (pdp?.test(r.path)) continue;
    by.set(r.path, (by.get(r.path) ?? 0) + r.visitors);
  }
  return [...by.entries()]
    .map(([page, views]) => ({ page, views, avg_depth: 0 }))
    .sort((a, b) => b.views - a.views);
}

/** O funil de uma rota no GA4. NULL = o GA4 não tem a rota. */
export function ga4FunnelFor(
  rows: readonly Ga4PageRow[],
  route: string,
): Ga4PageFunnel | null {
  const path = route === "/" ? "/" : route.replace(/\/+$/, "");
  const byDevice = rows
    .filter((r) => r.path === path)
    .map(({ device, visitors, viewed, carted }) => ({
      device,
      visitors,
      viewed,
      carted,
    }));
  return byDevice.length > 0 ? { route: path, by_device: byDevice } : null;
}

/** O Deco Analytics mediu o funil da página em algum dispositivo. */
function hasPageFunnel(behaviour: readonly DevicePdpBehaviour[]): boolean {
  return behaviour.some(
    (b) => b.funnel !== null && (b.funnel.viewed > 0 || b.funnel.carted > 0),
  );
}

// ── Comportamento na página (Deco Analytics) ─────────────────────────────────

/**
 * Seções que não são conteúdo: tema, fontes, pixels, VWO, consentimento.
 * Aparecem com 90%+ de alcance e tempo "visto" porque estão no DOM do topo,
 * não porque alguém as viu. Numa PDP medida em 04/11 eram 18 das 25 seções
 * do payload — todas com zero clique. O filtro de verdade é o clique; a regex
 * só tira as que somam clique por acidente (um pixel que intercepta toque).
 */
const NON_VISUAL_SECTION =
  /\/(Theme|Fonts|PageAssets|Tracking|Seo|SEO|Analytics|Pixel|Scripts?|VWO|ConsentManagement)\b|\/Tracking\//;

/** Nenhum projeto da org tem o Deco Analytics: o cliente é que instala. */
class AnalyticsNotInstalled extends Error {
  constructor(site: string) {
    super(`o site "${site}" não está registrado no Deco Analytics`);
    this.name = "AnalyticsNotInstalled";
  }
}

async function fetchPageBehaviour(
  heatmap: HeatmapReader,
  site: string,
  route: string,
  gaps: SourceGap[],
): Promise<DevicePdpBehaviour[]> {
  const devices: UxDevice[] = ["mobile", "desktop"];
  const payloads = await Promise.all(
    devices.map((device) => fetchHeatmapWithData(heatmap, site, route, device)),
  );
  if (payloads.every((p) => !p.registered)) {
    throw new AnalyticsNotInstalled(site);
  }
  const failed = failedPanels(payloads);
  if (failed.length > 0) {
    gaps.push({
      source: "heatmap",
      error: `a consulta do Deco Analytics falhou em ${failed.join(", ")} (${route}): esses painéis vieram vazios, não sem tráfego`,
    });
  }
  return payloads
    .map((payload, i) => toDeviceBehaviour(devices[i] ?? "mobile", payload))
    .filter((b): b is DevicePdpBehaviour => b !== null);
}

/**
 * Em 12/11 a rota respondia `registered: true` com todos os painéis vazios em
 * 9 de 10 chamadas seguidas (e às vezes só um painel cheio), sem erro nenhum.
 * Vazio não é "sem tráfego" numa PDP com milhões de views: tenta de novo.
 */
const HEATMAP_ATTEMPTS = 4;
const HEATMAP_RETRY_MS = 4_000;

async function fetchHeatmapWithData(
  heatmap: HeatmapReader,
  site: string,
  page: string,
  device: UxDevice,
): Promise<HeatmapPayload> {
  let last: HeatmapPayload | null = null;
  for (let attempt = 1; attempt <= HEATMAP_ATTEMPTS; attempt++) {
    last = await heatmap(site, { page, device, range: "7d" });
    if (!last.registered || hasHeatmapData(last)) return last;
    if (attempt < HEATMAP_ATTEMPTS) {
      await delay(HEATMAP_RETRY_MS);
    }
  }
  return last as HeatmapPayload;
}

/** Os painéis que falharam em algum dispositivo, sem repetir. */
export function failedPanels(payloads: readonly HeatmapPayload[]): string[] {
  return [
    ...new Set(
      payloads.flatMap((p) =>
        Array.isArray(p.data.failedPanels)
          ? p.data.failedPanels.filter((k) => typeof k === "string")
          : [],
      ),
    ),
  ].sort();
}

/** O resumo e os elementos vieram: é o mínimo pra ler a página. */
function hasHeatmapData(p: HeatmapPayload): boolean {
  return (
    (p.data.hmSummary?.[0]?.views ?? 0) > 0 &&
    (p.data.hmElements?.length ?? 0) > 0
  );
}

/** Quantos elementos vão pro prompt, por critério (mais clique, morto). */
const ELEMENTS_PER_CRITERION = 8;

/** Abaixo disso, a taxa de clique morto de um elemento é ruído. */
const MIN_ELEMENT_CLICKS = 200;

/**
 * Os elementos que valem ler: os mais clicados e os com mais clique morto em
 * elemento clicável (um botão que não respondeu). Morto em imagem ou texto
 * fica de fora do critério: é tocar na foto, não defeito.
 *
 * O clique de raiva do Deco Analytics (3+ cliques em 1 s) fica de fora de
 * propósito: conta cliques, não pessoas, e passar fotos rápido também conta.
 * Virava hipótese de "frustração" que não era (16/11).
 */
export function pickElements(
  payload: HeatmapPayload,
): DevicePdpBehaviour["elements"] {
  const funnelBy = new Map(
    (payload.data.hmFunnel ?? [])
      .filter((r) => r.root || String(r.el) !== "0")
      .map((r) => [`${r.root}|${String(r.el)}`, r]),
  );
  const all = (payload.data.hmElements ?? [])
    .filter((r) => !NON_VISUAL_SECTION.test(r.root))
    .map((r) => {
      const key = `${r.root}|${String(r.el)}`;
      const f = funnelBy.get(key);
      return {
        root: r.root,
        el: String(r.el),
        section: sectionName(r.root),
        clicks: Number(r.clicks ?? 0),
        dead: Number(r.dead ?? 0),
        dead_interactive: Number(r.dead_int ?? 0),
        funnel: f
          ? { visitors: Number(f.visitors ?? 0), carted: Number(f.carted ?? 0) }
          : null,
      };
    })
    .filter((e) => e.clicks > 0);
  const top = (score: (e: (typeof all)[number]) => number) =>
    [...all]
      .filter((e) => score(e) > 0)
      .sort((a, b) => score(b) - score(a))
      .slice(0, ELEMENTS_PER_CRITERION);
  const enough = (e: (typeof all)[number]) => e.clicks >= MIN_ELEMENT_CLICKS;
  const picked = new Map<string, (typeof all)[number]>();
  for (const e of [
    ...top((e) => e.clicks),
    ...top((e) => (enough(e) ? e.dead_interactive : 0)),
  ]) {
    picked.set(`${e.root}|${e.el}`, e);
  }
  return [...picked.values()].sort((a, b) => b.clicks - a.clicks);
}

const sectionName = (root: string) =>
  root.replace(/^site\/sections\//, "").replace(/\.tsx#\d+$/, "");

/** Payload `view=heatmap` → o recorte que o prompt e a tela leem. */
export function toDeviceBehaviour(
  device: UxDevice,
  payload: HeatmapPayload,
): DevicePdpBehaviour | null {
  const summary = payload.data.hmSummary?.[0];
  if (!summary?.views) return null;
  const scroll = payload.data.hmScroll ?? [];
  const reachAt = (depth: number): number => {
    // A curva é por ponto percentual; pega o primeiro ponto >= depth.
    const point = scroll.find((p) => p.depth >= depth);
    return point ? point.reach_pct : 0;
  };
  const pageRow = (payload.data.hmFunnel ?? []).find(
    (r) => !r.root && String(r.el) === "0",
  );
  const funnelMeasured =
    !pageRow ||
    Number(pageRow.viewed ?? 0) > 0 ||
    Number(pageRow.carted ?? 0) > 0;
  const elements = pickElements(payload);
  const sections = (payload.data.hmSections ?? [])
    .filter((s) => !NON_VISUAL_SECTION.test(s.root))
    .filter((s) => s.clicks > 0)
    .sort((a, b) => b.reach_pct - a.reach_pct)
    .slice(0, 15)
    .map((s) => ({
      section: sectionName(s.root),
      reach_pct: Number(s.reach_pct ?? 0),
      avg_seconds: Number(s.avg_s ?? 0),
      ctr_pct: Number(s.ctr_pct ?? 0),
      clicks: Number(s.clicks ?? 0),
    }));
  return {
    device,
    views: Number(summary.views ?? 0),
    avg_depth_pct: Number(summary.avg_depth ?? 0),
    avg_fold_pct: Number(summary.avg_fold ?? 0),
    active_seconds: Number(summary.active_s ?? 0),
    clicks: Number(summary.clicks ?? 0),
    dead_clicks: Number(summary.dead ?? 0),
    reach: { p25: reachAt(25), p50: reachAt(50), p75: reachAt(75) },
    scroll_curve:
      scroll.length > 0
        ? Array.from({ length: 21 }, (_, i) => ({
            depth: i * 5,
            reach_pct: reachAt(i * 5),
          }))
        : undefined,
    // Zero em "viu produto" e "carrinho" é evento que não chega, não ninguém comprando.
    funnel:
      pageRow && funnelMeasured
        ? {
            visitors: Number(pageRow.visitors ?? 0),
            viewed: Number(pageRow.viewed ?? 0),
            carted: Number(pageRow.carted ?? 0),
          }
        : null,
    sections,
    elements: funnelMeasured
      ? elements
      : elements?.map((e) => ({ ...e, funnel: null })),
  };
}

// ── Receita por canal (lake) ─────────────────────────────────────────────────

/** O lake respondeu, mas sem pedido pago na janela: o cliente é que traz os pedidos. */
class NoPaidOrders extends Error {
  constructor() {
    super("nenhum pedido pago nos últimos 28 dias");
    this.name = "NoPaidOrders";
  }
}

/** Sem pedido na janela, falha: vira lacuna que pede os pedidos ao cliente. */
async function fetchRevenueBase(lake: LakeQuery): Promise<RevenueBase> {
  const [rows, currencyRows] = await Promise.all([
    lake(
      `SELECT o.sales_channel AS channel_id,
			        any(c.name) AS name,
			        count() AS orders,
			        round(sum(o.total), 2) AS revenue
			   FROM customer_lake.orders AS o FINAL
			   LEFT JOIN (SELECT channel_id, any(name) AS name
			                FROM customer_lake.sales_channels FINAL
			               GROUP BY channel_id) AS c
			     ON c.channel_id = o.sales_channel
			  WHERE o.created_at >= now() - INTERVAL 28 DAY
			    AND o.status IN ('paid', 'fulfilled')
			  GROUP BY channel_id
			  ORDER BY revenue DESC
			  LIMIT 12`,
    ),
    lake("SELECT any(currency) AS currency FROM customer_lake.connections"),
  ]);
  if (rows.length === 0) {
    throw new NoPaidOrders();
  }
  return {
    window_days: 28,
    by_channel: rows.map((r) => {
      const orders = Number(r.orders ?? 0);
      const revenue = Number(r.revenue ?? 0);
      const name = String(r.name ?? "").trim();
      return {
        channel: name ? `${name} (${r.channel_id})` : String(r.channel_id),
        orders,
        revenue,
        avg_ticket: orders > 0 ? Math.round((revenue / orders) * 100) / 100 : 0,
      };
    }),
    currency: currencyRows[0]?.currency
      ? String(currencyRows[0].currency)
      : null,
  };
}

// ── Produtos: muito vistos x vendas x estoque ────────────────────────────────

/** Um produto muito visto, com ou sem problema. A escolha do print sai daqui. */
export type ProductRow = Omit<ProductSignal, "reason">;

async function fetchProductSignals(
  input: CollectInput,
  revenue: RevenueBase | null,
): Promise<{ signals: ProductSignal[]; rows: ProductRow[] }> {
  const bq = input.bigquery;
  const vtex = input.vtex;
  if (!bq || !vtex) return { signals: [], rows: [] };
  const views = await fetchPdpViews(bq.run, bq.projectId, bq.datasetId, {
    days: WINDOW_DAYS,
    onScan: input.onScan,
  });
  if (views.length === 0) return { signals: [], rows: [] };

  const orders = await fetchOrdersByProduct(input.lake, revenue).catch(
    () => new Map<string, number>(),
  );

  const top = [...views].sort((a, b) => b.views - a.views).slice(0, TOP_VIEWED);
  // Os que vendem bem e quase ninguém vê: vendas altas, views abaixo da mediana.
  const viewsById = new Map(views.map((v) => [v.product_id, v.views]));
  const medianViews =
    [...views].sort((a, b) => a.views - b.views)[Math.floor(views.length / 2)]
      ?.views ?? 0;
  const hidden = Array.from(orders.entries())
    .filter(
      ([id]) =>
        (viewsById.get(id) ?? 0) > 0 &&
        (viewsById.get(id) ?? 0) < medianViews * 3,
    )
    .map(([id, n]) => ({ id, rate: (n / (viewsById.get(id) ?? 1)) * 1000 }))
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 5)
    .map((h) => h.id);

  const ids = [...new Set([...top.map((t) => t.product_id), ...hidden])];
  const catalog: VtexCatalogSearchProduct[] = [];
  for (let i = 0; i < ids.length; i += 20) {
    catalog.push(
      ...(await vtexSearchByProductIds(
        vtex,
        ids.slice(i, i + 20),
        input.fetch,
      )),
    );
  }
  const byId = new Map(catalog.map((p) => [String(p.productId), p]));

  const rows: ProductRow[] = ids.map((id) => {
    const p = byId.get(id);
    const v = viewsById.get(id) ?? 0;
    const o = orders.get(id) ?? 0;
    const avail = readAvailability(p);
    const broken =
      avail.state === "alive" &&
      avail.totalSkus >= 3 &&
      avail.availableSkus / avail.totalSkus < 0.5;
    return {
      product_id: id,
      name: p?.productName ?? "",
      url: p?.linkText
        ? `https://${input.profile.domain}/${p.linkText}/p`
        : null,
      views: v,
      orders: o,
      orders_per_1k_views: v > 0 ? Math.round((o / v) * 1000 * 10) / 10 : 0,
      availability: (avail.state === "sold_out"
        ? "sold_out"
        : broken
          ? "broken_grid"
          : avail.state) as ProductSignal["availability"],
      available_skus: avail.availableSkus,
      total_skus: avail.totalSkus,
    };
  });

  const topRates = rows
    .filter((r) => top.some((t) => t.product_id === r.product_id))
    .map((r) => r.orders_per_1k_views)
    .sort((a, b) => a - b);
  const medianRate = topRates[Math.floor(topRates.length / 2)] ?? 0;

  const signals: ProductSignal[] = [];
  for (const r of rows) {
    let reason: ProductSignal["reason"] | null = null;
    if (hidden.includes(r.product_id)) reason = "converte_e_ninguem_ve";
    else if (r.availability === "sold_out") reason = "esgotado_com_trafego";
    else if (r.availability === "broken_grid") reason = "grade_quebrada";
    else if (r.orders_per_1k_views < medianRate * 0.5) reason = "nao_convence";
    if (reason) signals.push({ ...r, reason });
  }
  return {
    signals: signals.sort((a, b) => b.views - a.views).slice(0, 25),
    rows: rows
      .filter((r) => top.some((t) => t.product_id === r.product_id))
      .sort((a, b) => b.views - a.views),
  };
}

/**
 * Pedidos por produto no canal do site, 7 dias. O canal do site é o que a VTEX
 * chama de "Principal" (ou o id 1, o padrão da VTEX) — o app vende por outro
 * canal e não passa pela PDP do site.
 */
async function fetchOrdersByProduct(
  lake: LakeQuery,
  revenue: RevenueBase | null,
): Promise<Map<string, number>> {
  const principal = siteChannel(revenue);
  const channelId = principal?.channel.match(/\((\w+)\)$/)?.[1] ?? "1";
  const rows = await lake(
    `SELECT item.2 AS product_id, sum(item.7) AS qty
		   FROM customer_lake.orders FINAL
		  ARRAY JOIN items AS item
		  WHERE created_at >= now() - INTERVAL ${WINDOW_DAYS} DAY
		    AND sales_channel = '${channelId.replace(/'/g, "")}'
		    AND status IN ('paid', 'fulfilled')
		  GROUP BY product_id
		  ORDER BY qty DESC
		  LIMIT 1000`,
  );
  return new Map(rows.map((r) => [String(r.product_id), Number(r.qty ?? 0)]));
}

/**
 * As PDPs que vão ao navegador:
 *
 *   1. a mais vista com a grade inteira à venda: é a PDP comum, a que o modelo
 *      deve olhar pra falar da página. Em 12/11 a "mais vista à venda" tinha
 *      1 de 5 tamanhos, e o modelo desenhou solução de
 *      esgotado achando que era a página de sempre;
 *   2. a mais vista esgotada ou com grade quebrada, marcada como tal.
 *
 * Sem produto com grade inteira, a mais vista à venda (marcada com o estoque
 * dela). Sem produto nenhum (BigQuery fora), a home — o diagnóstico perde a
 * captura de PDP mas não para. Exportado pra teste.
 */
export function pickCaptureTargets(
  viewed: ProductRow[],
  domain: string,
): CaptureCandidate[] {
  const out: CaptureCandidate[] = [];
  const withUrl = viewed.filter((p) => p.url);
  const main =
    withUrl.find(
      (p) => p.availability === "alive" && p.available_skus === p.total_skus,
    ) ??
    withUrl.find((p) => p.availability === "alive") ??
    withUrl.find((p) => p.availability !== "sold_out");
  const full =
    main?.availability === "alive" && main.available_skus === main.total_skus;
  if (main?.url) {
    out.push({
      url: main.url,
      product_id: main.product_id,
      why: full
        ? "a mais vista com a grade inteira"
        : "a mais vista à venda (nenhuma com a grade inteira)",
      stock: main.availability,
    });
  }
  const short = withUrl.find(
    (p) =>
      p !== main &&
      (p.availability === "sold_out" || p.availability === "broken_grid"),
  );
  if (short?.url) {
    out.push({
      url: short.url,
      product_id: short.product_id,
      why:
        short.availability === "sold_out"
          ? "a mais vista esgotada"
          : "a mais vista com a grade quebrada",
      stock: short.availability,
    });
  }
  if (out.length === 0) {
    out.push({
      url: `https://${domain}/`,
      product_id: "",
      why: "sem dados de produto: home",
      stock: null,
    });
  }
  return out;
}
