/**
 * A métrica de cada oportunidade, medida em código.
 *
 * Antes a oportunidade só citava números em texto ("11,1% (desktop 20,3%)") e a
 * base do dinheiro era a que o modelo escrevesse. Agora o modelo só diz QUAL
 * etapa do funil o problema afeta, em qual dispositivo e contra qual; a taxa, a
 * amostra e o gap saem daqui, dos mesmos dados que o modelo leu.
 *
 * As etapas do GA4 contam usuárias que fizeram cada evento na janela (não
 * necessariamente na ordem; ver buildPlatformFunnelQuery). As do Deco Analytics
 * são o funil da própria página analisada (PDP, home, categoria, busca):
 * visitantes → viram produto → puseram no carrinho.
 */

import type {
  DiagnosisEvidence,
  UxDevice,
  UxPageType,
  UxSourceKind,
} from "./types.ts";

export type UxMetricKey =
  | "sessao_produto"
  | "produto_carrinho"
  | "carrinho_checkout"
  | "checkout_compra"
  | "produto_compra"
  | "pdp_carrinho"
  | "lista_produto"
  | "promo_clique"
  | "vercarrinho_checkout"
  | "checkout_frete"
  | "frete_pagamento"
  | "pagamento_compra"
  | "pagina_produto"
  | "pagina_carrinho";

interface MetricDef {
  label: string;
  source: Extract<UxSourceKind, "ga4" | "deco_analytics">;
  /** Eventos do GA4: denominador → numerador. */
  from?: string;
  to?: string;
}

export const UX_METRICS: Record<UxMetricKey, MetricDef> = {
  sessao_produto: {
    label: "entrou no site → viu produto",
    source: "ga4",
    from: "session_start",
    to: "view_item",
  },
  produto_carrinho: {
    label: "viu produto → carrinho",
    source: "ga4",
    from: "view_item",
    to: "add_to_cart",
  },
  carrinho_checkout: {
    label: "carrinho → checkout",
    source: "ga4",
    from: "add_to_cart",
    to: "begin_checkout",
  },
  checkout_compra: {
    label: "checkout → compra",
    source: "ga4",
    from: "begin_checkout",
    to: "purchase",
  },
  produto_compra: {
    label: "viu produto → compra",
    source: "ga4",
    from: "view_item",
    to: "purchase",
  },
  pdp_carrinho: {
    label: "visitou a PDP → carrinho",
    source: "deco_analytics",
  },
  lista_produto: {
    label: "viu vitrine de produtos → clicou num produto",
    source: "ga4",
    from: "view_item_list",
    to: "select_item",
  },
  promo_clique: {
    label: "viu banner → clicou no banner",
    source: "ga4",
    from: "view_promotion",
    to: "select_promotion",
  },
  vercarrinho_checkout: {
    label: "abriu o carrinho → checkout",
    source: "ga4",
    from: "view_cart",
    to: "begin_checkout",
  },
  checkout_frete: {
    label: "checkout → informou entrega",
    source: "ga4",
    from: "begin_checkout",
    to: "add_shipping_info",
  },
  frete_pagamento: {
    label: "informou entrega → informou pagamento",
    source: "ga4",
    from: "add_shipping_info",
    to: "add_payment_info",
  },
  pagamento_compra: {
    label: "informou pagamento → compra",
    source: "ga4",
    from: "add_payment_info",
    to: "purchase",
  },
  pagina_produto: {
    label: "visitou a página → viu produto",
    source: "deco_analytics",
  },
  pagina_carrinho: {
    label: "visitou a página → carrinho",
    source: "deco_analytics",
  },
};

/** Eventos do GA4 que alguma métrica usa: o funil lê só estes. */
export const GA4_METRIC_EVENTS: string[] = [
  ...new Set(
    Object.values(UX_METRICS).flatMap((d) =>
      d.from && d.to ? [d.from, d.to] : [],
    ),
  ),
];

export const isMetricKey = (v: unknown): v is UxMetricKey =>
  typeof v === "string" && Object.hasOwn(UX_METRICS, v);

/** O que o modelo escolhe: a etapa, o dispositivo e contra quem comparar. */
export interface UxMetricRef {
  key: UxMetricKey;
  device: UxDevice;
  /** NULL = sem comparação (o problema não é "um dispositivo pior que o outro"). */
  compare_to: UxDevice | null;
  /**
   * O segmento que a oportunidade culpa ("a mídia paga traz gente que não
   * converte"). Os recortes conferem se ele converte mesmo pior que o resto,
   * e as hipóteses têm que explicar por que pesam mais nele. NULL = a
   * oportunidade é de todo mundo.
   */
  segment?: SegmentRef | null;
  /**
   * Contra o quê a perda foi medida (losses.ts). Decide o que conta como
   * causa: perda de DISPOSITIVO precisa de causa que muda entre as telas;
   * perda ABSOLUTA (sem comparação) aceita causa que vale pras duas; perda de
   * SEGMENTO precisa de causa que pesa mais nele. Ausente = antes de 16/11.
   */
  control?: LossControl;
}

/** Contra o quê uma perda foi medida. */
export type LossControl = "dispositivo" | "segmento" | "absoluta";

export interface SegmentRef {
  dim: "canal" | "visitante";
  key: string;
}

export interface MetricSample {
  device: UxDevice;
  /** Denominador: quem chegou na etapa de partida. */
  n: number;
  /** Numerador: quem passou pra próxima. */
  hits: number;
  rate: number;
}

/** A métrica medida. Tudo aqui é conta nossa, nada do modelo. */
export interface MeasuredMetric extends MetricSample {
  key: UxMetricKey;
  label: string;
  source: MetricDef["source"];
  window_days: number;
  comp: MetricSample | null;
  /**
   * (taxa da comparação − taxa daqui) em pontos percentuais. Positivo = aqui
   * está pior. NULL = sem comparação.
   */
  gap_pp: number | null;
  /** A etapa pedida era do GA4, que não respondeu; mediu pelo funil da PDP. */
  fallback?: true;
}

const PLATFORM: Record<UxDevice, string> = {
  mobile: "web_mobile",
  desktop: "web_desktop",
};

function sample(
  device: UxDevice,
  n: number,
  hits: number,
): MetricSample | null {
  // Funil aberto do GA4 pode inverter: numa loja (16/11) 2.515 fizeram
  // begin_checkout e só 1.733 view_cart, e "carrinho → checkout" saía 145%.
  // Taxa acima de 100% não é conta: sem amostra.
  if (!(n > 0) || !(hits >= 0) || hits > n) return null;
  return { device, n, hits, rate: hits / n };
}

function ga4Sample(
  evidence: DiagnosisEvidence,
  def: MetricDef,
  device: UxDevice,
): MetricSample | null {
  const funnel = evidence.platform_funnel.find(
    (f) => f.platform === PLATFORM[device],
  );
  if (!funnel) return null;
  const count = (event?: string) =>
    funnel.steps.find((s) => s.event === event)?.count;
  const n = count(def.from);
  const hits = count(def.to);
  return n == null || hits == null ? null : sample(device, n, hits);
}

/** Um funil de página: quem entrou → viu produto → pôs no carrinho. */
type PageFunnel = { visitors: number; viewed: number; carted: number };

/**
 * De onde sai o funil da página analisada: o Deco Analytics quando ele mediu
 * (em algum dispositivo), senão o GA4. Uma fonte só pra todos os
 * dispositivos, pra que a comparação celular × computador não misture contas.
 */
export function pageFunnelSource(evidence: DiagnosisEvidence): {
  source: "deco_analytics" | "ga4";
  funnel: (d: UxDevice) => PageFunnel | null;
} | null {
  // Visitantes sem nenhum "viu produto" nem "carrinho" = a loja não manda
  // esses eventos ao Deco Analytics (numa loja, 16/11), não taxa 0%.
  const measured = (f: PageFunnel | null | undefined): PageFunnel | null =>
    f && (f.viewed > 0 || f.carted > 0) ? f : null;
  if (evidence.pdp_behaviour.some((b) => measured(b.funnel))) {
    return {
      source: "deco_analytics",
      funnel: (d) =>
        measured(evidence.pdp_behaviour.find((b) => b.device === d)?.funnel),
    };
  }
  const ga4 = evidence.ga4_page_funnel?.by_device ?? [];
  if (ga4.some((f) => measured(f))) {
    return {
      source: "ga4",
      funnel: (d) => measured(ga4.find((f) => f.device === d)),
    };
  }
  return null;
}

/** O funil da página analisada (Deco Analytics, ou o do GA4 quando ele não tem). */
function pageSample(
  evidence: DiagnosisEvidence,
  key: UxMetricKey,
  device: UxDevice,
): MetricSample | null {
  const funnel = pageFunnelSource(evidence)?.funnel(device);
  if (!funnel) return null;
  return sample(
    device,
    funnel.visitors,
    key === "pagina_produto" ? funnel.viewed : funnel.carted,
  );
}

/**
 * A métrica escolhida, medida nos dados desta análise. NULL = os dados não
 * têm essa etapa nesse dispositivo. "viu produto → carrinho" sem GA4 cai pro
 * funil da PDP (a mesma etapa vista pelo Deco Analytics), e diz isso.
 */
export function measureMetric(
  evidence: DiagnosisEvidence,
  ref: UxMetricRef,
  pageType: UxPageType = "pdp",
): MeasuredMetric | null {
  if (!metricFitsPage(ref.key, pageType)) return null;
  let key = ref.key;
  let def = UX_METRICS[key];
  const read = (d: UxDevice) =>
    def.source === "ga4"
      ? ga4Sample(evidence, def, d)
      : pageSample(evidence, key, d);
  let main = read(ref.device);
  let fallback = false;
  if (!main && key === "produto_carrinho" && pageType === "pdp") {
    key = "pdp_carrinho";
    def = UX_METRICS[key];
    main = read(ref.device);
    fallback = true;
  }
  if (!main) return null;
  const comp =
    ref.compare_to && ref.compare_to !== ref.device
      ? read(ref.compare_to)
      : null;
  return {
    ...main,
    key,
    label: def.label,
    source:
      def.source === "deco_analytics"
        ? (pageFunnelSource(evidence)?.source ?? def.source)
        : def.source,
    window_days: evidence.window_days,
    comp,
    gap_pp: comp ? round2((comp.rate - main.rate) * 100) : null,
    ...(fallback ? { fallback: true as const } : {}),
  };
}

/** Resposta do modelo → referência válida, ou null. */
export function parseMetricRef(
  raw: unknown,
  opportunityDevice: UxDevice | "ambos",
): UxMetricRef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isMetricKey(r.key)) return null;
  const asDevice = (v: unknown): UxDevice | null =>
    v === "mobile" || v === "desktop" ? v : null;
  const device =
    asDevice(r.device) ??
    (opportunityDevice === "ambos" ? "mobile" : opportunityDevice);
  const compare = asDevice(r.compare_to);
  return {
    key: r.key,
    device,
    compare_to: compare && compare !== device ? compare : null,
  };
}

/**
 * A etapa existe nos dados deste tipo de página? O funil do Deco Analytics é
 * o da página analisada: `pdp_carrinho` só na PDP, `pagina_*` só fora dela, e
 * nada no carrinho/checkout (é da VTEX, sem heatmap). As do GA4 valem sempre.
 */
export function metricFitsPage(
  key: UxMetricKey,
  pageType: UxPageType,
): boolean {
  return PAGE_METRICS[pageType].includes(key);
}

/**
 * As etapas que cada página move. Na 1ª rodada do site inteiro (numa loja,
 * 16/11) home, categoria, busca e checkout escolheram "viu produto →
 * carrinho" — a etapa da PDP —, e o mesmo sintoma apareceu 4 vezes no topo da
 * lista, cada um com o próprio dinheiro. Cada página fica com as dela; a PDP
 * com as de sempre.
 */
const PAGE_METRICS: Record<UxPageType, UxMetricKey[]> = {
  home: [
    "sessao_produto",
    "promo_clique",
    "lista_produto",
    "pagina_produto",
    "pagina_carrinho",
  ],
  categoria: ["lista_produto", "pagina_produto", "pagina_carrinho"],
  busca: ["lista_produto", "pagina_produto", "pagina_carrinho"],
  pdp: [
    "sessao_produto",
    "produto_carrinho",
    "carrinho_checkout",
    "checkout_compra",
    "produto_compra",
    "pdp_carrinho",
  ],
  carrinho_checkout: [
    "carrinho_checkout",
    "vercarrinho_checkout",
    "checkout_frete",
    "frete_pagamento",
    "pagamento_compra",
    "checkout_compra",
  ],
};

/**
 * As etapas que medem a PÁGINA analisada, e não o site inteiro. O funil do
 * GA4 é por plataforma, do site todo: "viu vitrine → clicou num produto" soma a
 * home, a recomendação da PDP, a busca e todas as categorias. Em 16/11 (numa loja
 * de moda) a categoria /colecao/promo foi julgada por esse número — o mesmo
 * 37,8% x 23,2% que a busca citou —, e com o sinal trocado. Uma oportunidade
 * só se mede numa etapa daqui; as outras ficam como contexto.
 *
 * - home, categoria, busca: o funil do Deco Analytics da própria rota;
 * - PDP: view_item → add_to_cart (o view_item é o evento da PDP); sem GA4, o
 *   funil da PDP no Deco Analytics (fallback de measureMetric);
 * - carrinho/checkout: os eventos do GA4 que só acontecem nele.
 */
const PAGE_SCOPED: Record<UxPageType, UxMetricKey[]> = {
  home: ["pagina_produto", "pagina_carrinho"],
  categoria: ["pagina_produto", "pagina_carrinho"],
  busca: ["pagina_produto", "pagina_carrinho"],
  pdp: ["produto_carrinho"],
  carrinho_checkout: [
    "vercarrinho_checkout",
    "carrinho_checkout",
    "checkout_frete",
    "frete_pagamento",
    "pagamento_compra",
    "checkout_compra",
  ],
};

/** A etapa mede a página analisada (e não o site inteiro)? */
export function metricMeasuresPage(
  key: UxMetricKey,
  pageType: UxPageType,
): boolean {
  return PAGE_SCOPED[pageType].includes(key);
}

/** As etapas que medem a página analisada. */
export function pageScopedMetrics(pageType: UxPageType): UxMetricKey[] {
  return [...PAGE_SCOPED[pageType]];
}

/**
 * O evento do GA4 que equivale ao numerador de cada etapa: é dele que sai
 * "quanto vale cada pessoa a mais que passa". As do Deco Analytics usam o
 * evento do GA4 do mesmo passo (viu produto = view_item; carrinho =
 * add_to_cart).
 */
const REACHED_EVENT: Record<UxMetricKey, string> = {
  sessao_produto: "view_item",
  produto_carrinho: "add_to_cart",
  carrinho_checkout: "begin_checkout",
  checkout_compra: "purchase",
  produto_compra: "purchase",
  pdp_carrinho: "add_to_cart",
  // Clicar num produto da vitrine leva à PDP: vale o mesmo que ver produto.
  lista_produto: "view_item",
  // Clicar no banner não leva necessariamente a produto: vale uma sessão.
  promo_clique: "session_start",
  vercarrinho_checkout: "begin_checkout",
  checkout_frete: "add_shipping_info",
  frete_pagamento: "add_payment_info",
  pagamento_compra: "purchase",
  pagina_produto: "view_item",
  pagina_carrinho: "add_to_cart",
};

/**
 * Quantas de quem chega ao numerador da etapa compram, no dispositivo: compra
 * ÷ o evento do numerador, no funil do GA4 da plataforma. Era o modelo que
 * escrevia isto, e em 16/11 aplicou "compra ÷ carrinho" (10,8%) a um clique na
 * vitrine, que está duas etapas antes do carrinho. NULL = sem GA4.
 */
export function purchaseRateAfter(
  evidence: DiagnosisEvidence,
  key: UxMetricKey,
  device: UxDevice,
): { rate: number; event: string } | null {
  const event = REACHED_EVENT[key];
  if (event === "purchase") return { rate: 1, event };
  const funnel = evidence.platform_funnel.find(
    (f) => f.platform === PLATFORM[device],
  );
  const count = (e: string) => funnel?.steps.find((s) => s.event === e)?.count;
  const reached = count(event);
  const bought = count("purchase");
  if (!reached || reached <= 0 || bought == null || bought < 0) return null;
  return { rate: Math.min(1, bought / reached), event };
}

/** Os nomes das etapas pro prompt, só as que existem neste tipo de página. */
export function metricsForPrompt(pageType: UxPageType = "pdp"): string {
  return (Object.entries(UX_METRICS) as Array<[UxMetricKey, MetricDef]>)
    .filter(([key]) => metricFitsPage(key, pageType))
    .map(([key, def]) => `- ${key}: ${def.label} (${def.source})`)
    .join("\n");
}

const round2 = (v: number) => Math.round(v * 100) / 100;
