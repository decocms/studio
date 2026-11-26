/**
 * Each opportunity's metric, measured in code. The model only picks the funnel
 * step, device and comparison; rate, sample and gap are computed here from the
 * same data. GA4 steps count users per event (not necessarily in order);
 * Deco Analytics steps are the analyzed page's own funnel.
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
  /** GA4 events: denominator -> numerator. */
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

/** What the model picks: the step, the device and what to compare against. */
export interface UxMetricRef {
  key: UxMetricKey;
  device: UxDevice;
  /** NULL = no comparison (the problem is not "one device worse than the other"). */
  compare_to: UxDevice | null;
  /**
   * The segment the opportunity blames; the breakdowns check it really converts
   * worse than the rest. NULL = the opportunity applies to everyone.
   */
  segment?: SegmentRef | null;
  /**
   * What the loss was measured against (losses.ts); decides which causes count.
   * Absent = older data.
   */
  control?: LossControl;
}

/** What a loss was measured against. */
export type LossControl = "dispositivo" | "segmento" | "absoluta";

export interface SegmentRef {
  dim: "canal" | "visitante";
  key: string;
}

export interface MetricSample {
  device: UxDevice;
  /** Denominator: who reached the starting step. */
  n: number;
  /** Numerator: who moved on to the next step. */
  hits: number;
  rate: number;
}

/** The measured metric. Everything here is our own computation, nothing from the model. */
export interface MeasuredMetric extends MetricSample {
  key: UxMetricKey;
  label: string;
  source: MetricDef["source"];
  window_days: number;
  comp: MetricSample | null;
  /** (comparison rate - rate here) in percentage points; positive = worse here. NULL = no comparison. */
  gap_pp: number | null;
  /** The requested step was a GA4 one, which did not answer; measured via the PDP funnel. */
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
  // An open GA4 funnel can invert (e.g. "cart -> checkout" above 100%); a rate over 100% is not a measure, so no sample.
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

/** A page funnel: who entered -> viewed product -> added to cart. */
type PageFunnel = { visitors: number; viewed: number; carted: number };

/**
 * Source of the analyzed page's funnel: Deco Analytics when it measured, else
 * GA4. One source for all devices so the device comparison stays consistent.
 */
function pageFunnelSource(evidence: DiagnosisEvidence): {
  source: "deco_analytics" | "ga4";
  funnel: (d: UxDevice) => PageFunnel | null;
} | null {
  // Visitors with no "viewed product" or "cart" at all mean the store does not send those events to Deco Analytics, not a 0% rate.
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

/** The analyzed page's funnel (Deco Analytics, or GA4's when it has none). */
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
 * The chosen metric measured on this analysis's data; NULL = no such step on
 * that device. "viewed product -> cart" without GA4 falls back to the PDP funnel.
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

/** Model answer -> valid reference, or null. */
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
 * Does the step exist for this page type? Deco Analytics steps are the
 * analyzed page's own; none on cart/checkout (VTEX-owned). GA4 steps always apply.
 */
export function metricFitsPage(
  key: UxMetricKey,
  pageType: UxPageType,
): boolean {
  return PAGE_METRICS[pageType].includes(key);
}

/** The steps each page moves, so the same symptom is not repeated across pages. */
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
 * The steps that measure the analyzed PAGE, not the whole site: GA4 funnels are
 * per platform and site-wide, so only these can ground an opportunity; the
 * others stay as context.
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

/** Does the step measure the analyzed page (and not the whole site)? */
export function metricMeasuresPage(
  key: UxMetricKey,
  pageType: UxPageType,
): boolean {
  return PAGE_SCOPED[pageType].includes(key);
}

/** The steps that measure the analyzed page. */
export function pageScopedMetrics(pageType: UxPageType): UxMetricKey[] {
  return [...PAGE_SCOPED[pageType]];
}

/** The GA4 event equivalent to each step's numerator, used to value each extra person who gets through. */
const REACHED_EVENT: Record<UxMetricKey, string> = {
  sessao_produto: "view_item",
  produto_carrinho: "add_to_cart",
  carrinho_checkout: "begin_checkout",
  checkout_compra: "purchase",
  produto_compra: "purchase",
  pdp_carrinho: "add_to_cart",
  // Clicking a showcase product leads to the PDP: worth the same as viewing a product.
  lista_produto: "view_item",
  // Clicking the banner does not necessarily lead to a product: worth one session.
  promo_clique: "session_start",
  vercarrinho_checkout: "begin_checkout",
  checkout_frete: "add_shipping_info",
  frete_pagamento: "add_payment_info",
  pagamento_compra: "purchase",
  pagina_produto: "view_item",
  pagina_carrinho: "add_to_cart",
};

/**
 * How many of those reaching the step's numerator buy, on the device:
 * purchase / the numerator event in the platform's GA4 funnel. NULL = no GA4.
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

/** Step names for the prompt, only those that exist for this page type. */
export function metricsForPrompt(pageType: UxPageType = "pdp"): string {
  return (Object.entries(UX_METRICS) as Array<[UxMetricKey, MetricDef]>)
    .filter(([key]) => metricFitsPage(key, pageType))
    .map(([key, def]) => `- ${key}: ${def.label} (${def.source})`)
    .join("\n");
}

const round2 = (v: number) => Math.round(v * 100) / 100;
