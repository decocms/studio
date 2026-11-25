/**
 * "Dá pra confiar nesses dados?" — a avaliação de cada oportunidade antes de
 * ela avançar. Regra do motor: nenhuma oportunidade vai pra frente sem isto.
 *
 * Tudo determinístico. As checagens:
 * 1. Amostra: poucas pessoas na etapa não sustentam taxa nenhuma.
 * 2. Ruído: a diferença entre os dispositivos cabe no intervalo de 95%?
 * 3. Fontes: alguma fonte que a oportunidade cita falhou nesta análise?
 * 4. Tracking: os números se contradizem (mais carrinho que produto visto,
 *    GA4 e Deco Analytics contando coisas de tamanhos muito diferentes)?
 * 5. Comparação justa: quanto do gap o mix de tráfego explica, e se o gap
 *    se repete nos canais, em nova × recorrente e dia a dia (segments.ts).
 * 6. Janela: 7 dias não pegam sazonalidade (só aviso).
 *
 * Nível: algo que bloqueia → baixa; alguma atenção → média; senão alta.
 */

import type { MeasuredMetric, UxMetricRef } from "./metrics.ts";
import {
  type Drilldown,
  mixExplainedShare,
  type SegmentPremise,
} from "./segments.ts";
import type {
  DiagnosisEvidence,
  SourceGap,
  UxDevice,
  UxSourceKind,
  UxSourceRef,
} from "./types.ts";

export type ReliabilitySeverity = "ok" | "info" | "atencao" | "bloqueia";

export interface ReliabilityCheck {
  code:
    | "amostra"
    | "ruido"
    | "fonte"
    | "tracking"
    | "metrica"
    | "comparacao"
    | "recorte"
    | "premissa"
    | "janela";
  severity: ReliabilitySeverity;
  /** O que foi checado, curto ("Amostra"). */
  label: string;
  /** O resultado, com número. */
  text: string;
}

export type ReliabilityLevel = "alta" | "media" | "baixa";

export interface DataReliability {
  level: ReliabilityLevel;
  checks: ReliabilityCheck[];
}

/** Abaixo disso a taxa não sustenta nada. */
export const MIN_SAMPLE = 400;
/** Abaixo disso a taxa vale, com cuidado. */
const SOLID_SAMPLE = 2_000;
/** GA4 x Deco Analytics contando a mesma etapa: fora desta razão, algo mede errado. */
const MAX_SOURCE_RATIO = 3;

const GAP_KINDS: Record<SourceGap["source"], UxSourceKind | null> = {
  bigquery: "ga4",
  heatmap: "deco_analytics",
  lake: "vtex",
  vtex: "vtex",
  browser: "pagina",
  benchmark: "benchmark",
  studio: null,
  github: null,
};

const DEVICE_WORD: Record<UxDevice, string> = {
  mobile: "celular",
  desktop: "computador",
};

const fmtInt = (n: number) => Math.round(n).toLocaleString("pt-BR");
const fmtPct = (r: number) =>
  `${(r * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;

export function assessReliability(input: {
  evidence: DiagnosisEvidence;
  device: UxDevice | "ambos";
  sources: UxSourceRef[];
  metric: UxMetricRef | null;
  measured: MeasuredMetric | null;
  /** Os recortes do gap (segments.ts). Ausente = sem recorte. */
  drilldown?: Drilldown | null;
  /** O segmento que a oportunidade culpa, contra o resto (segments.ts). */
  premise?: SegmentPremise | null;
}): DataReliability {
  const { evidence, measured } = input;
  const checks: ReliabilityCheck[] = [];

  if (!input.metric) {
    checks.push({
      code: "metrica",
      severity: "atencao",
      label: "Métrica",
      text: "Sem etapa do funil ligada: o tamanho do problema vem só dos números citados.",
    });
  } else if (!measured) {
    checks.push({
      code: "metrica",
      severity: "atencao",
      label: "Métrica",
      text: "A etapa escolhida não existe nos dados desta análise: não deu pra medir em código.",
    });
  } else {
    checks.push(...sampleChecks(measured));
  }

  if (input.premise) checks.push(...premiseChecks(input.premise));
  if (input.drilldown) checks.push(...fairnessChecks(input.drilldown));
  checks.push(...sourceChecks(evidence.gaps, input.sources, measured));
  const devices: UxDevice[] =
    input.device === "ambos" ? ["mobile", "desktop"] : [input.device];
  checks.push(...trackingChecks(evidence, devices));
  checks.push({
    code: "janela",
    severity: "info",
    label: "Janela",
    text: `${evidence.window_days} dias: não pega sazonalidade nem lançamento fora da janela.`,
  });

  const level: ReliabilityLevel = checks.some((c) => c.severity === "bloqueia")
    ? "baixa"
    : checks.some((c) => c.severity === "atencao")
      ? "media"
      : "alta";
  return { level, checks };
}

function sampleChecks(m: MeasuredMetric): ReliabilityCheck[] {
  const out: ReliabilityCheck[] = [];
  const smallest = m.comp ? Math.min(m.n, m.comp.n) : m.n;
  const where = m.comp
    ? `${fmtInt(m.n)} no ${DEVICE_WORD[m.device]}, ${fmtInt(m.comp.n)} no ${DEVICE_WORD[m.comp.device]}`
    : `${fmtInt(m.n)} no ${DEVICE_WORD[m.device]}`;
  out.push({
    code: "amostra",
    label: "Amostra",
    severity:
      smallest < MIN_SAMPLE
        ? "bloqueia"
        : smallest < SOLID_SAMPLE
          ? "atencao"
          : "ok",
    text: `${where} em "${m.label.split(" → ")[0]}" (${m.window_days} dias).`,
  });
  if (m.fallback) {
    out.push({
      code: "metrica",
      severity: "atencao",
      label: "Métrica",
      text: "Sem GA4: a etapa foi medida pelo funil da PDP no Deco Analytics.",
    });
  }
  if (m.comp) {
    const diff = m.comp.rate - m.rate;
    const se = Math.sqrt(
      (m.rate * (1 - m.rate)) / m.n +
        (m.comp.rate * (1 - m.comp.rate)) / m.comp.n,
    );
    const margin = 1.96 * se;
    const noise = Math.abs(diff) <= margin;
    // O sinal: o dispositivo que a oportunidade diz perder tem que perder.
    // Em 16/11 (categoria de uma loja de moda) "o celular perde no card" foi medida com o
    // celular clicando 37,8% contra 23,2% do computador, saiu "média" e
    // valia R$ 387 mil/mês. Diferença fora do ruído pro lado errado é o
    // dado dizendo o contrário.
    const reversed = !noise && diff < 0;
    out.push({
      code: "ruido",
      label: "Diferença",
      severity: noise || reversed ? "bloqueia" : "ok",
      text: noise
        ? `${fmtPct(m.rate)} x ${fmtPct(m.comp.rate)}: a diferença cabe no ruído (±${fmtPct(margin)}).`
        : reversed
          ? `${fmtPct(m.rate)} no ${DEVICE_WORD[m.device]} x ${fmtPct(m.comp.rate)} no ${DEVICE_WORD[m.comp.device]}: o ${DEVICE_WORD[m.device]} está MELHOR — o dado diz o contrário da perda.`
          : `${fmtPct(m.rate)} x ${fmtPct(m.comp.rate)}: diferença fora do ruído (±${fmtPct(margin)}).`,
    });
  }
  return out;
}

function sourceChecks(
  gaps: SourceGap[],
  sources: UxSourceRef[],
  measured: MeasuredMetric | null,
): ReliabilityCheck[] {
  const cited = new Set<UxSourceKind>(sources.map((s) => s.source));
  if (measured) cited.add(measured.source);
  const out: ReliabilityCheck[] = [];
  const seen = new Set<string>();
  for (const g of gaps) {
    const kind = GAP_KINDS[g.source];
    if (!kind || !cited.has(kind) || seen.has(g.source)) continue;
    seen.add(g.source);
    out.push({
      code: "fonte",
      severity: "atencao",
      label: "Fonte",
      text: `${g.source} falhou em parte nesta análise: ${g.error.slice(0, 140)}`,
    });
  }
  return out;
}

function trackingChecks(
  evidence: DiagnosisEvidence,
  devices: UxDevice[],
): ReliabilityCheck[] {
  const out: ReliabilityCheck[] = [];
  for (const device of devices) {
    const platform = device === "mobile" ? "web_mobile" : "web_desktop";
    const funnel = evidence.platform_funnel.find(
      (f) => f.platform === platform,
    );
    const count = (event: string) =>
      funnel?.steps.find((s) => s.event === event)?.count ?? 0;
    const word = DEVICE_WORD[device];
    if (funnel) {
      const viewed = count("view_item");
      const carted = count("add_to_cart");
      if (viewed > 0 && carted > viewed) {
        out.push({
          code: "tracking",
          severity: "atencao",
          label: "Tracking",
          text: `No ${word}, ${fmtInt(carted)} puseram no carrinho e só ${fmtInt(viewed)} viram produto no GA4: compra rápida pela vitrine ou view_item faltando.`,
        });
      }
      const checkout = count("begin_checkout");
      const bought = count("purchase");
      if (checkout > 0 && bought > checkout) {
        out.push({
          code: "tracking",
          severity: "atencao",
          label: "Tracking",
          text: `No ${word}, ${fmtInt(bought)} compraram e só ${fmtInt(checkout)} começaram o checkout no GA4: begin_checkout faltando.`,
        });
      }
    }
    const pdp = evidence.pdp_behaviour.find((b) => b.device === device)?.funnel;
    const viewed = count("view_item");
    // Só na PDP o GA4 "vendo produto" e o Deco Analytics "visitantes da
    // página" medem a mesma coisa; numa categoria, a comparação não é
    // contradição nenhuma (e o texto dizia "visitantes da PDP").
    if ((evidence.page_type ?? "pdp") !== "pdp") continue;
    if (funnel && pdp && pdp.visitors > 0 && viewed > 0) {
      const ratio = viewed / pdp.visitors;
      if (ratio > MAX_SOURCE_RATIO || ratio < 1 / MAX_SOURCE_RATIO) {
        out.push({
          code: "tracking",
          severity: "atencao",
          label: "Tracking",
          text: `No ${word}, o GA4 conta ${fmtInt(viewed)} pessoas vendo produto e o Deco Analytics ${fmtInt(pdp.visitors)} visitantes da PDP: as fontes não medem a mesma coisa.`,
        });
      }
    }
  }
  return out;
}

const MIX_LABEL = { canal: "de canais", visitante: "de nova × recorrente" };
const DIM_LABEL = {
  canal: "canais",
  visitante: "grupos (nova × recorrente)",
  dia: "dias",
};

/** Mix de tráfego e consistência do gap nos recortes. */
function fairnessChecks(d: Drilldown): ReliabilityCheck[] {
  const out: ReliabilityCheck[] = [];
  const mix = mixExplainedShare(d);
  if (mix) {
    const pct = Math.round(mix.share * 100);
    const pp = (v: number | undefined) =>
      (v ?? 0).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
    const adj = pp(d.mix_adjusted_gap_pp[mix.dim]);
    const gap = pp(d.gap_pp);
    out.push({
      code: "comparacao",
      label: "Comparação justa",
      severity: mix.share >= 0.5 ? "atencao" : "ok",
      text:
        mix.share >= 0.5
          ? `${pct}% do gap vem da mistura ${MIX_LABEL[mix.dim]}, não da tela: com a mesma mistura do ${DEVICE_WORD[d.comp_device]}, o gap cai de ${gap} para ${adj} pp.`
          : `Com a mesma mistura ${MIX_LABEL[mix.dim]} do ${DEVICE_WORD[d.comp_device]}, o gap fica em ${adj} pp (era ${gap}): o mix explica ${pct}%.`,
    });
  }
  for (const dim of ["canal", "visitante", "dia"] as const) {
    const c = d.consistency[dim];
    if (!c || c.total < 2) continue;
    const steady =
      dim === "dia" ? c.same === c.total : c.same / c.total >= 2 / 3;
    out.push({
      code: "recorte",
      label: "Se repete",
      severity: steady ? "ok" : "atencao",
      text: steady
        ? `O gap aparece em ${c.same} de ${c.total} ${DIM_LABEL[dim]}.`
        : `O gap só aparece em ${c.same} de ${c.total} ${DIM_LABEL[dim]}: pode ser um recorte, não a página.`,
    });
  }
  return out;
}

/** Nome dos segmentos pra frase. */
export const SEGMENT_WORD: Record<string, string> = {
  midia_paga: "mídia paga",
  social_pago: "social pago",
  busca_organica: "busca orgânica",
  social: "social",
  crm: "CRM / e-mail",
  direto: "direto",
  referencia: "referência",
  outros: "outros canais",
  nova: "cliente nova",
  recorrente: "cliente recorrente",
};

/** Mais que isso de diferença de tela no segmento = a diferença é dele. */
const SEGMENT_SPECIFIC = 1.25;

/**
 * A oportunidade culpa um segmento: ele converte mesmo pior que o resto? E a
 * diferença de tela é dele, ou aparece em todo mundo? Exportado pra teste.
 */
export function premiseChecks(p: SegmentPremise): ReliabilityCheck[] {
  const name = SEGMENT_WORD[p.key] ?? p.key;
  const rest = p.dim === "canal" ? "os outros canais" : "o resto";
  const device = DEVICE_WORD[p.device];
  const out: ReliabilityCheck[] = [];
  if (p.rate >= p.rest_rate) {
    out.push({
      code: "premissa",
      severity: "bloqueia",
      label: "Premissa",
      text: `${name} não converte menos que ${rest} no ${device} (${fmtPct(p.rate)} x ${fmtPct(p.rest_rate)}): o problema não é de ${name}.`,
    });
    return out;
  }
  const comp =
    p.comp_device && p.comp_rate != null && p.comp_rest_rate != null
      ? ` No ${DEVICE_WORD[p.comp_device]}: ${fmtPct(p.comp_rate)} x ${fmtPct(p.comp_rest_rate)}.`
      : "";
  out.push({
    code: "premissa",
    severity: "info",
    label: "Premissa",
    text: `${name}: ${fmtPct(p.rate)} no ${device}, contra ${fmtPct(p.rest_rate)} de ${rest}.${comp}`,
  });
  if (
    p.comp_device &&
    p.comp_rate != null &&
    p.comp_rest_rate != null &&
    p.rate > 0 &&
    p.rest_rate > 0
  ) {
    const here = p.comp_rate / p.rate;
    const elsewhere = p.comp_rest_rate / p.rest_rate;
    if (elsewhere > 1 && here <= elsewhere * SEGMENT_SPECIFIC) {
      const x = (v: number) =>
        v.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
      out.push({
        code: "premissa",
        severity: "atencao",
        label: "Premissa",
        text: `O ${DEVICE_WORD[p.comp_device]} ganha do ${device} também fora de ${name} (${x(elsewhere)}× contra ${x(here)}× em ${name}): essa diferença de tela é da página e vale pra todos. O que faz ${name} converter menos tem que ser outra coisa.`,
      });
    }
  }
  return out;
}
