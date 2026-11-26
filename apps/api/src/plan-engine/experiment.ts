/**
 * A ready hypothesis's recommended test: control, variant, metrics, guardrails,
 * and the sample and duration calculation. The system only PROPOSES the A/B;
 * the math is ours (two-sided, α 5%, power 80%, minimum effect 3% relative).
 */

import { measureMetric, UX_METRICS, type UxMetricKey } from "./metrics.ts";
import { pageSpec } from "./page-types.ts";
import type { HypothesisRelevance } from "./relevance.ts";
import type {
  DiagnosisEvidence,
  UxArea,
  UxDevice,
  UxHypothesis,
  UxOpportunity,
} from "./types.ts";

const Z_ALPHA = 1.959964; // two-sided, α = 5%
const Z_POWER = 0.841621; // power 80%
/** Minimum relative effect: below it the test never ends. */
const MIN_RELATIVE_EFFECT = 0.03;
/** With no stated effect, half a point. */
const DEFAULT_EFFECT_PP = 0.5;
const MIN_WEEKS = 2;
const MAX_WEEKS = 8;

/** Sample per group to detect p1 → p2. Infinity if there is no difference. */
export function sampleSizePerGroup(p1: number, p2: number): number {
  const d = Math.abs(p2 - p1);
  if (!(d > 0) || p1 <= 0 || p1 >= 1 || p2 <= 0 || p2 >= 1) {
    return Number.POSITIVE_INFINITY;
  }
  const pBar = (p1 + p2) / 2;
  const a = Z_ALPHA * Math.sqrt(2 * pBar * (1 - pBar));
  const b = Z_POWER * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil(((a + b) * (a + b)) / (d * d));
}

/** The smallest absolute effect that `perGroup` people per group detect. */
export function detectableEffect(p1: number, perGroup: number): number | null {
  if (!(perGroup > 0) || p1 <= 0 || p1 >= 1) return null;
  let lo = 1e-5;
  let hi = Math.min(1 - p1, p1) - 1e-6;
  if (sampleSizePerGroup(p1, p1 + hi) > perGroup) return null;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (sampleSizePerGroup(p1, p1 + mid) <= perGroup) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** What else to look at, per page part. */
const SECONDARY_BY_AREA: Partial<Record<UxArea, string[]>> = {
  tamanho: ["toques no seletor de tamanho", "aberturas do guia de medidas"],
  botao_compra: ["cliques no botão de compra"],
  galeria: ["fotos vistas por visita", "rolagem até o preço"],
  titulo_preco: ["rolagem até o preço"],
  frete_entrega: ["cálculos de frete na PDP"],
  descricao: ["aberturas da descrição"],
  leve_o_look: ["cliques no Leve o Look", "itens por pedido"],
  recomendacoes: ["cliques nas vitrines", "itens por pedido"],
  confianca: ["aberturas de troca e devolução"],
  home_destaque: ["cliques no destaque", "visitas que chegam a um produto"],
  home_vitrines: ["cliques nas vitrines", "produtos vistos por visita"],
  menu_busca: ["aberturas do menu", "buscas feitas"],
  topo_categoria: ["cliques nos atalhos de subcategoria"],
  card_produto: ["cliques em card", "produtos vistos por visita"],
  filtros_ordenacao: ["uso de filtro", "uso de ordenação"],
  paginacao: ["produtos carregados por visita"],
  campo_busca: ["buscas feitas", "cliques nas sugestões"],
  resultados_busca: ["cliques no 1º resultado", "buscas refeitas"],
  busca_sem_resultado: ["buscas sem resultado que viram clique"],
  carrinho: ["cupons aplicados", "itens removidos"],
  checkout: ["erros de formulário", "trocas de forma de pagamento"],
};

export interface ExperimentDesign {
  controle: string;
  variante: string;
  metrica_primaria: { key: UxMetricKey; label: string; device: UxDevice };
  secundarias: string[];
  guardrails: string[];
  metodo: string;
  /** Baseline of the primary metric (0-1) and how many pass the stage per week. */
  baseline: number;
  weekly_at_step: number;
  /** Fraction of traffic the change reaches (relevance), 0-1. */
  exposure: number;
  weekly_eligible: number;
  /** Minimum detectable effect the test targets, in pp. */
  mde_pp: number;
  direction: "sobe" | "desce";
  n_per_group: number;
  weeks: number;
  measurable: boolean;
  /** The smallest effect 4 weeks detect, in pp. NULL = not even with everything. */
  mde_4_weeks_pp: number | null;
  limitacoes: string[];
}

const pct = (v: number) =>
  `${(v * 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;

export function designExperiment(input: {
  hypothesis: Pick<
    UxHypothesis,
    "title" | "idea" | "device" | "tree" | "after_url"
  >;
  opportunity: Pick<UxOpportunity, "area" | "metric">;
  evidence: DiagnosisEvidence;
  relevance: HypothesisRelevance | null | undefined;
}): ExperimentDesign | null {
  const { hypothesis: h, opportunity: o, evidence } = input;
  const device: UxDevice = h.device === "desktop" ? "desktop" : "mobile";
  const spec = pageSpec(evidence.page_type);
  const key: UxMetricKey =
    h.tree?.metrica.key ?? o.metric?.key ?? spec.defaultMetric;
  const measured = measureMetric(
    evidence,
    { key, device, compare_to: null },
    spec.key,
  );
  if (!measured || measured.rate <= 0 || measured.rate >= 1) return null;
  const p1 = measured.rate;
  const direction = h.tree?.metrica.direcao ?? "sobe";
  const effect =
    (h.tree?.metrica.efeito_esperado_pp ?? DEFAULT_EFFECT_PP) / 100;
  const mde = Math.max(effect, p1 * MIN_RELATIVE_EFFECT);
  const p2 = direction === "desce" ? p1 - mde : p1 + mde;
  const n = sampleSizePerGroup(p1, p2);
  const weekly = (measured.n * 7) / (evidence.window_days || 7);
  const exposure = Math.min(
    1,
    Math.max(0, (input.relevance?.affected_pct ?? 100) / 100),
  );
  const eligible = weekly * exposure;
  const rawWeeks =
    Number.isFinite(n) && eligible > 0 ? (2 * n) / eligible : Infinity;
  const weeks = Number.isFinite(rawWeeks)
    ? Math.max(MIN_WEEKS, Math.ceil(rawWeeks))
    : Number.POSITIVE_INFINITY;
  const measurable = weeks <= MAX_WEEKS;
  const in4 = detectableEffect(p1, (eligible * 4) / 2);

  const area = o.area;
  const guardrails =
    spec.key === "pdp"
      ? [
          "taxa de compra (viu produto → compra)",
          "receita por visitante",
          "ticket médio",
          "cliques mortos na PDP",
        ]
      : [
          "taxa de compra",
          "receita por visitante",
          ...spec.guardrails.filter((g) => !/LCP/.test(g)),
        ];
  if (area === "galeria" || h.tree?.category === "performance") {
    guardrails.push(
      spec.key === "pdp"
        ? "LCP da PDP no celular"
        : `LCP d${spec.noun.startsWith("o ") ? "o" : "a"} ${spec.label.toLowerCase()} no celular`,
    );
  }
  const primaryLabel = UX_METRICS[measured.key].label;
  const limitacoes = [
    "A conta usa usuárias de uma semana; quem volta em outra semana conta de novo, então a duração real tende a ser um pouco maior.",
    "Duração em semanas inteiras, pra pegar o ciclo de lançamento (quarta) igual nos dois grupos.",
  ];
  if (measured.fallback) {
    limitacoes.push(
      `Sem GA4: a linha de base é o funil d${spec.key === "pdp" ? "a PDP" : `${spec.noun.startsWith("o ") ? "o" : "a"} ${spec.label.toLowerCase()}`} do Deco Analytics.`,
    );
  }
  if (!input.relevance) {
    limitacoes.push(
      "Sem relevância medida: a conta supõe que a mudança atinge toda visualização.",
    );
  }
  if (!measurable) {
    limitacoes.push(
      `Com este tráfego, ${pct(mde)} de efeito levaria mais de ${MAX_WEEKS} semanas: não é mensurável agora.`,
    );
  }
  return {
    controle: `${spec.control}${h.tree?.causa ? ` (${h.tree.causa.toLowerCase()})` : ""}.`,
    variante: `${h.idea || h.title}${h.after_url ? " — ver o Depois desenhado." : ""}`,
    metrica_primaria: { key: measured.key, label: primaryLabel, device },
    secundarias: SECONDARY_BY_AREA[area] ?? [],
    guardrails,
    metodo: `A/B 50/50 por usuária, no ${device === "mobile" ? "celular" : "computador"}, bicaudal, α 5%, poder 80%${exposure < 0.9 ? "; análise só de quem chega à parte mudada (exposição)" : ""}.`,
    baseline: p1,
    weekly_at_step: Math.round(weekly),
    exposure,
    weekly_eligible: Math.round(eligible),
    mde_pp: Math.round(mde * 10_000) / 100,
    direction,
    n_per_group: Number.isFinite(n) ? n : -1,
    weeks: Number.isFinite(weeks) ? weeks : -1,
    measurable,
    mde_4_weeks_pp: in4 === null ? null : Math.round(in4 * 10_000) / 100,
    limitacoes,
  };
}
