/**
 * Opportunities, in code: each is a loss measured WITH a comparison (losses.ts),
 * ranked by residual money × data reliability. No model in the path.
 */

import { sourceLabel } from "./claims.ts";
import { factBook, type UxFact } from "./facts.ts";
import { findLosses, type MeasuredLoss } from "./losses.ts";
import { purchaseRateAfter, type UxMetricKey } from "./metrics.ts";
import { lossMoney } from "./money.ts";
import { assessReliability, SEGMENT_WORD } from "./reliability.ts";
import { type Drilldown, drilldown, mixExplainedShare } from "./segments.ts";
import type {
  DiagnosisEvidence,
  DiagnosisSummary,
  OpportunityDraft,
  UxDevice,
  UxObservation,
  UxSourceRef,
} from "./types.ts";

/** How many opportunities go to the screen (the rest become reserves). */
const MAX_OPPORTUNITIES = 2;

/** How many observations per opportunity. */
const MAX_OBSERVATIONS = 4;

/** Below this (pp), the gap left after discounting the audience mix is the traffic's, not the page's. */
export const MIN_RESIDUAL_PP = 1;

/** The losing side must convert at most this share of the other to count as a device loss. */
const DEVICE_MAX_RATIO = 0.9;

/** The opportunity value is per this many pp (the cap is the whole residual). */
const VALUE_STEP_PP = 1;

/** Coverage difference (pp) of the layers over the first screen between screens that counts. */
const LAYER_GAP_PP = 20;

/** Dead-click difference (pp) of the same element between screens that counts. */
const DEAD_GAP_PP = 20;

export interface OpportunitiesResult {
  summary: DiagnosisSummary;
  opportunities: OpportunityDraft[];
  /** Left out by value alone; they replace a chosen opportunity whose hypotheses all fall. */
  reserves: OpportunityDraft[];
}

const DEVICE_WORD: Record<UxDevice, string> = {
  mobile: "celular",
  desktop: "computador",
};
const MIX_WORD = { canal: "de canais", visitante: "de nova × recorrente" };

const pp = (v: number) =>
  v.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
const pctWord = (r: number) =>
  `${(r * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
const round2 = (v: number) => Math.round(v * 100) / 100;

export interface LossResidual {
  /** The whole loss in pp. */
  gap_pp: number;
  /** What is left for the page to explain, in pp. */
  residual_pp: number;
  /** The audience dimension that best explains the gap, and how much (0-1). */
  mix: { dim: "canal" | "visitante"; share: number } | null;
  drilldown: Drilldown | null;
}

/** Share of the loss left for the page after discounting the audience mix (device losses only). Exported for tests. */
export function lossResidual(
  loss: MeasuredLoss,
  evidence: DiagnosisEvidence,
): LossResidual {
  if (loss.control !== "dispositivo") {
    return {
      gap_pp: loss.loss_pp,
      residual_pp: loss.loss_pp,
      mix: null,
      drilldown: null,
    };
  }
  const d = drilldown(loss.measured, evidence.segments);
  const mix = d ? mixExplainedShare(d) : null;
  return {
    gap_pp: loss.loss_pp,
    residual_pp: round2(loss.loss_pp * (1 - (mix?.share ?? 0))),
    mix,
    drilldown: d,
  };
}

/** A captured page that shows the missing state (not the usual page). */
const isShortageGroup = (group: string) =>
  /GRADE QUEBRADA|ESGOTADO/.test(group);

/** What differs between screens (part position, page fact, dead click), from the facts. Exported for tests. */
export function contrastObservations(facts: UxFact[]): UxObservation[] {
  const firstGroup = (device: UxDevice) =>
    facts.find(
      (f) =>
        f.source === "pagina" &&
        f.device === device &&
        !isShortageGroup(f.group),
    )?.group ?? null;
  const groups = {
    mobile: firstGroup("mobile"),
    desktop: firstGroup("desktop"),
  };
  const out: UxObservation[] = [];

  // Real page: position and page facts, from the part before the ":".
  if (groups.mobile && groups.desktop) {
    const byLabel = (device: UxDevice) => {
      const m = new Map<string, UxFact>();
      for (const f of facts) {
        if (f.group !== groups[device]) continue;
        if (f.kind !== "posicao" && f.kind !== "pagina") continue;
        const label = f.text.split(":")[0]!;
        if (label.startsWith("o que aparece") || label.startsWith("altura"))
          continue;
        m.set(label, f);
      }
      return m;
    };
    const mob = byLabel("mobile");
    const desk = byLabel("desktop");
    for (const [label, fm] of mob) {
      const fd = desk.get(label);
      if (!fd) continue;
      const vm = fm.text.slice(label.length + 1).trim();
      const vd = fd.text.slice(label.length + 1).trim();
      if (fm.kind === "posicao") {
        const inM = vm.includes("na 1ª tela");
        const inD = vd.includes("na 1ª tela");
        if (inM === inD) continue;
      } else if (vm === vd) {
        continue;
      }
      out.push({
        text: `${label}: no celular, ${vm}; no computador, ${vd}`,
        facts: [fm.id, fd.id],
      });
    }
  }

  // Elements with the same label on both screens and a very different dead click.
  const elements = (device: UxDevice) => {
    const m = new Map<string, { fact: UxFact; dead: number }>();
    for (const f of facts) {
      if (f.kind !== "elemento" || f.device !== device) continue;
      const label = f.text.split(" · ")[0]!;
      if (label.includes("não achado")) continue;
      const dead = /mortos ([\d.]+)%/.exec(f.text);
      if (!dead || m.has(label)) continue;
      m.set(label, { fact: f, dead: Number(dead[1]) });
    }
    return m;
  };
  const em = elements("mobile");
  const ed = elements("desktop");
  for (const [label, m] of em) {
    const d = ed.get(label);
    if (!d || Math.abs(m.dead - d.dead) < DEAD_GAP_PP) continue;
    out.push({
      text: `${label}: ${pp(m.dead)}% de cliques mortos no celular e ${pp(d.dead)}% no computador`,
      facts: [m.fact.id, d.fact.id],
    });
  }
  // Layers over the first screen (probe): the largest of each screen, or "none".
  const layer = (device: UxDevice) => {
    let best: { fact: UxFact; pct: number } | null = null;
    for (const f of facts) {
      if (f.kind !== "interacao" || f.device !== device) continue;
      const m = /cobre ([\d.]+)% da 1ª tela/.exec(f.text);
      const pct = m
        ? Number(m[1])
        : f.text.startsWith("nenhuma camada")
          ? 0
          : null;
      if (pct === null) continue;
      if (!best || pct > best.pct) best = { fact: f, pct };
    }
    return best;
  };
  const lm = layer("mobile");
  const ld = layer("desktop");
  if (lm && ld && Math.abs(lm.pct - ld.pct) >= LAYER_GAP_PP) {
    const say = (l: { pct: number }) =>
      l.pct > 0
        ? `uma camada fixa cobre ${pp(l.pct)}% da 1ª tela`
        : "nenhuma camada fixa cobre a 1ª tela";
    out.unshift({
      text: `ao abrir a página sem fechar nada: no celular, ${say(lm)}; no computador, ${say(ld)}`,
      facts: [lm.fact.id, ld.fact.id],
    });
  }
  return out.slice(0, MAX_OBSERVATIONS);
}

/** The measured loss as the first number of the "based on" text. */
function lossSource(loss: MeasuredLoss): UxSourceRef {
  const m = loss.measured;
  const value = loss.premise
    ? `${pctWord(loss.premise.rate)} (resto ${pctWord(loss.premise.rest_rate)})`
    : m.comp
      ? `${pctWord(m.rate)} (${DEVICE_WORD[m.comp.device]} ${pctWord(m.comp.rate)})`
      : pctWord(m.rate);
  return {
    source: m.source,
    metric: `${m.label} no ${DEVICE_WORD[m.device]}${loss.segment ? ` — ${SEGMENT_WORD[loss.segment.key] ?? loss.segment.key}` : ""}`,
    value,
    window: `${m.window_days} dias`,
    label: sourceLabel(m.source),
  };
}

/** The opportunity summary, in code: the loss, the mix and what is left. */
function lossSummary(loss: MeasuredLoss, r: LossResidual): string {
  if (loss.control === "segmento" && loss.premise) {
    const name = SEGMENT_WORD[loss.premise.key] ?? loss.premise.key;
    return `${name.charAt(0).toUpperCase()}${name.slice(1)} converte ${pp(loss.loss_pp)} pp abaixo do resto no ${DEVICE_WORD[loss.device]} (n=${loss.premise.n.toLocaleString("pt-BR")}). A causa tem que pesar mais nesse público.`;
  }
  const other = loss.compare_to ? DEVICE_WORD[loss.compare_to] : "outro";
  if (!r.mix) {
    return `O ${DEVICE_WORD[loss.device]} fica ${pp(r.gap_pp)} pp atrás do ${other}. Não há recorte de público pra descontar a mistura: parte disso pode ser tráfego.`;
  }
  return `O ${DEVICE_WORD[loss.device]} fica ${pp(r.gap_pp)} pp atrás do ${other}. A mistura ${MIX_WORD[r.mix.dim]} explica ${Math.round(r.mix.share * 100)}% disso; sobram ${pp(r.residual_pp)} pp pra página explicar.`;
}

const RELIABILITY_WEIGHT = { alta: 0.8, media: 0.6, baixa: 0.3 };

/** The same stage (the PDP stage in GA4 and Deco Analytics is a single one). */
const SAME_STEP: UxMetricKey[][] = [
  ["produto_carrinho", "pdp_carrinho"],
  ["pagina_produto", "lista_produto"],
];
const sameStep = (a: UxMetricKey, b: UxMetricKey) =>
  a === b || SAME_STEP.some((g) => g.includes(a) && g.includes(b));

interface Ranked {
  draft: OpportunityDraft;
  score: number;
  key: UxMetricKey;
  device: UxDevice;
}

/**
 * Losses → opportunities: only those with a comparison. The 2 of highest value
 * go to the screen (never two of the same stage and device); the rest become
 * reserves or limits, with the reason.
 */
export function opportunitiesFromLosses(
  evidence: DiagnosisEvidence,
  losses: MeasuredLoss[] = findLosses(evidence),
  facts: UxFact[] = factBook(evidence),
): OpportunitiesResult {
  const limits: string[] = [];
  const pageType = evidence.page_type ?? "pdp";
  const absolute = losses.filter((l) => l.control === "absoluta");
  const compared = losses.filter((l) => l.control !== "absoluta");
  const observations = contrastObservations(facts);

  const ranked: Ranked[] = [];
  const traffic: string[] = [];
  const tiny: string[] = [];
  for (const loss of compared) {
    const comp = loss.measured.comp;
    if (
      loss.control === "dispositivo" &&
      comp &&
      comp.rate > 0 &&
      loss.measured.rate > comp.rate * DEVICE_MAX_RATIO
    ) {
      tiny.push(`"${loss.title}"`);
      continue;
    }
    const r = lossResidual(loss, evidence);
    if (loss.control === "dispositivo" && r.residual_pp < MIN_RESIDUAL_PP) {
      traffic.push(
        `"${loss.title}" (a mistura ${r.mix ? MIX_WORD[r.mix.dim] : "de público"} explica ${Math.round((r.mix?.share ?? 0) * 100)}% do gap; sobram ${pp(r.residual_pp)} pp)`,
      );
      continue;
    }
    const metric = {
      key: loss.key,
      device: loss.device,
      compare_to: loss.compare_to,
      control: loss.control,
      ...(loss.segment ? { segment: loss.segment } : {}),
    };
    const sources = [lossSource(loss)];
    const reliability = assessReliability({
      evidence,
      device: loss.device,
      sources,
      metric,
      measured: loss.measured,
      drilldown: r.drilldown,
      premise: loss.premise,
    });
    const deviceWord = DEVICE_WORD[loss.device];
    const money = lossMoney({
      n: loss.premise?.n ?? loss.measured.n,
      window_days: loss.measured.window_days,
      step: loss.measured.label,
      deviceWord,
      // The ruler is 1 pp; the effect the change closes belongs to the hypothesis.
      delta_pp: Math.min(VALUE_STEP_PP, r.residual_pp),
      gap_pp: r.residual_pp,
      purchase: purchaseRateAfter(evidence, loss.measured.key, loss.device),
      revenue: evidence.revenue,
      assumption: `cada ${pp(Math.min(VALUE_STEP_PP, r.residual_pp))} pp dos ${pp(r.residual_pp)} pp que ${loss.control === "dispositivo" ? "sobram depois da mistura de público" : "separam esse público do resto"}`,
    });
    const confidence = RELIABILITY_WEIGHT[reliability.level];
    const draft: OpportunityDraft = {
      rank: 0,
      area: "pagina_geral",
      title: loss.title,
      summary: lossSummary(loss, r),
      device: loss.device,
      sources,
      money,
      confidence,
      metric,
      measured: loss.measured,
      reliability,
      drilldown: r.drilldown,
      observations: loss.control === "dispositivo" ? observations : [],
    };
    // Unsupported data goes last; without a calculation, behind those with one.
    const score =
      reliability.level === "baixa"
        ? -2 + confidence
        : money
          ? money.monthly_value * confidence
          : -1 + confidence;
    ranked.push({ draft, score, key: loss.key, device: loss.device });
  }
  ranked.sort((a, b) => b.score - a.score);

  const picked: Ranked[] = [];
  const repeated: Ranked[] = [];
  const reserves: Ranked[] = [];
  for (const c of ranked) {
    if (picked.some((p) => p.device === c.device && sameStep(p.key, c.key))) {
      repeated.push(c);
    } else if (picked.length < MAX_OPPORTUNITIES) {
      picked.push(c);
    } else {
      reserves.push(c);
    }
  }
  // Same-stage losses go last as reserves, in case the chosen one falls.
  const opportunities = picked.map((c, i) => ({ ...c.draft, rank: i + 1 }));

  if (repeated.length > 0) {
    limits.push(
      `Mesma etapa e mesmo dispositivo de uma escolhida (ficam de reserva): ${repeated.map((c) => `"${c.draft.title}"`).join("; ")}.`,
    );
  }
  if (tiny.length > 0) {
    limits.push(
      `Diferença entre as telas pequena demais pra ser problema de tela (o lado que perde converte mais de ${Math.round(DEVICE_MAX_RATIO * 100)}% do outro): ${tiny.join("; ")}.`,
    );
  }
  if (traffic.length > 0) {
    limits.push(
      `Perdas que o tráfego explica, não a página (não viram oportunidade): ${traffic.join("; ")}.`,
    );
  }
  if (absolute.length > 0) {
    limits.push(
      `Sem comparação não há como dizer se a perda é grande, então ${absolute.length === 1 ? "esta etapa não virou" : `estas ${absolute.length} etapas não viraram`} oportunidade: ${absolute
        .slice(0, 3)
        .map((l) => `"${l.title}"`)
        .join("; ")}${absolute.length > 3 ? "…" : ""}.`,
    );
  }
  const noMoney = ranked.filter((c) => !c.draft.money);
  if (noMoney.length > 0) {
    limits.push(
      `Sem valor em dinheiro (falta o ticket do site na VTEX ou a taxa de compra no GA4): ${noMoney.map((c) => `"${c.draft.title}"`).join("; ")}.`,
    );
  }
  if (losses.length === 0) {
    limits.push(
      "Nenhuma etapa desta página tem dado nesta análise: sem perda medida, não há oportunidade.",
    );
  }

  return {
    summary: {
      headline: headline(opportunities, pageType === "pdp"),
      limits,
    },
    opportunities,
    reserves: [...reserves, ...repeated].map((c) => c.draft),
  };
}

const brl = (v: number) =>
  `R$ ${Math.round(v).toLocaleString("pt-BR", { maximumFractionDigits: 0 })}`;

/** The headline, in code: the chosen losses and what they are worth. */
function headline(opportunities: OpportunityDraft[], _pdp: boolean): string {
  if (opportunities.length === 0) {
    return "Nenhuma perda com comparação nesta página: nem celular x computador nem um público fica fora do ruído (ou o tráfego explica a diferença).";
  }
  return opportunities
    .map((o, i) => {
      const value = o.money
        ? ` Cada ${pp(o.money.delta_pp)} pp vale ${brl(o.money.monthly_value)}/mês${o.money.ceiling_monthly ? `; a perda inteira, ${brl(o.money.ceiling_monthly)}` : ""}.`
        : "";
      return `${i === 0 ? "A maior perda medida" : "Depois"}: ${o.title}. ${o.summary}${value}`;
    })
    .join(" ");
}
