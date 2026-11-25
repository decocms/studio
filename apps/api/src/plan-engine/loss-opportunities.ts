/**
 * As oportunidades, em código: cada uma é uma perda medida COM comparação
 * (losses.ts), sem nenhum modelo no caminho.
 *
 * Até 19/11 um modelo escolhia a perda e escrevia "observações", resumo,
 * área e confiança. A observação vinha interpretada ("a seta… parece não
 * responder", PDP de uma loja de moda, 16/11) e o prompt das hipóteses mandava cada uma
 * virar hipótese. O resumo enquadrava as hipóteses, a área decidia a base de
 * conhecimento antes de existir causa, e a confiança dele ordenava a tela.
 * Agora:
 * - a perda só entra com comparação (celular x computador, segmento x resto).
 *   "No computador, 74% não põem no carrinho" não diz se isso é muito;
 * - a mistura de público (canal, nova × recorrente) é descontada do gap: o
 *   que sobra (o resíduo) é o que a página precisa explicar. Resíduo abaixo
 *   de MIN_RESIDUAL_PP: a perda é do tráfego e não vira oportunidade;
 * - as observações são o que MUDA entre as telas, lido dos fatos (facts.ts):
 *   posição na 1ª tela, fato da página, clique morto do mesmo elemento. É o
 *   que se vê, com o id do fato; a causa é trabalho da hipótese;
 * - a ordem é dinheiro do resíduo × confiabilidade dos dados.
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

/** Quantas oportunidades vão pra tela (as demais viram reserva). */
export const MAX_OPPORTUNITIES = 2;

/** Quantas observações por oportunidade. */
export const MAX_OBSERVATIONS = 4;

/**
 * Abaixo disso (pp), o que sobra do gap entre as telas depois de descontar a
 * mistura de público não é da página: a perda é do tráfego.
 */
export const MIN_RESIDUAL_PP = 1;

/**
 * O lado que perde converte no máximo isto do outro pra ser oportunidade de
 * dispositivo (a mesma régua do segmento, SEGMENT_MAX_RATIO). Com amostra de
 * centenas de milhares, 49,4% x 51,3% fica fora do ruído e não é problema de
 * tela nenhuma (categoria e busca de uma loja de moda, 16/11, no replay de 19/11).
 */
export const DEVICE_MAX_RATIO = 0.9;

/** O valor da oportunidade é por este tanto de pp (o teto é o resíduo inteiro). */
export const VALUE_STEP_PP = 1;

/** Diferença de cobertura (pp) das camadas sobre a 1ª tela entre as telas que conta. */
const LAYER_GAP_PP = 20;

/** Diferença de clique morto (pp) do mesmo elemento entre as telas que conta. */
const DEAD_GAP_PP = 20;

export interface OpportunitiesResult {
  summary: DiagnosisSummary;
  opportunities: OpportunityDraft[];
  /**
   * As que ficaram de fora só por valor, na ordem de valor. Entram no lugar
   * de uma escolhida cujas hipóteses caem todas.
   */
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
  /** A perda inteira em pp. */
  gap_pp: number;
  /** O que sobra pra página explicar, em pp. */
  residual_pp: number;
  /** A dimensão de público que mais explica o gap, e quanto (0–1). */
  mix: { dim: "canal" | "visitante"; share: number } | null;
  drilldown: Drilldown | null;
}

/**
 * Quanto da perda sobra pra página depois de descontar a mistura de público.
 * Só a perda de dispositivo tem mistura a descontar: a de segmento já é o
 * público. Exportado pra teste.
 */
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

/** Página capturada que mostra o estado de falta (não a página de sempre). */
const isShortageGroup = (group: string) =>
  /GRADE QUEBRADA|ESGOTADO/.test(group);

/**
 * O que muda entre as telas, lido dos fatos: a mesma parte numa tela dentro
 * da 1ª tela e na outra fora; o mesmo fato da página com valor diferente; o
 * mesmo elemento com clique morto muito diferente. Só a primeira captura de
 * cada tela que não está em falta. Exportado pra teste.
 */
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

  // Página real: posição e fatos da página, pela parte antes do ":".
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

  // Elementos com o mesmo rótulo nas duas telas e clique morto bem diferente.
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
  // Camadas sobre a 1ª tela (sonda): a maior de cada tela, ou "nenhuma".
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

/** A perda medida como o primeiro número do "baseado em". */
export function lossSource(loss: MeasuredLoss): UxSourceRef {
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

/** O resumo da oportunidade, em código: a perda, a mistura e o que sobra. */
export function lossSummary(loss: MeasuredLoss, r: LossResidual): string {
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

/** A mesma etapa (a da PDP no GA4 e no Deco Analytics é uma só). */
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
 * As perdas → oportunidades: só as com comparação, com o resíduo, as
 * observações de contraste, a conta e a confiabilidade. As 2 de maior valor
 * vão pra tela, sem duas da mesma etapa no mesmo dispositivo; o resto vira
 * reserva. Tudo que fica de fora vira limite, com o motivo.
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
      // A régua é 1 pp: quanto vale cada ponto. Quanto a mudança fecha é
      // da hipótese (efeito esperado), não da perda; o teto é o resíduo.
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
    // Dado que não se sustenta vai pro fim; sem conta, atrás das com conta.
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
  // As da mesma etapa entram como reserva no fim: se a escolhida cair, a
  // outra leitura da mesma perda ainda pode explicar.
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

/** A manchete, em código: as perdas escolhidas e quanto valem. */
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
