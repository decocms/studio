/**
 * "O gap se repete?" — a métrica de uma oportunidade dentro de cada recorte
 * do funil (canal de aquisição, usuária nova × recorrente, dia).
 *
 * Duas perguntas que um gap de dispositivo precisa responder antes de virar
 * problema de página:
 *
 * 1. Se repete? Se o celular perde do computador só em um canal, o problema é
 *    o canal, não a página.
 * 2. A comparação é justa? Se o celular recebe muito mais tráfego de campanha
 *    (que converte menos em qualquer tela), parte do gap é o mix. O gap
 *    ajustado aplica as taxas do celular por canal na MISTURA de canais do
 *    computador: o que sobra é o que o mix não explica.
 *
 * Tudo conta, nada de modelo. Só vale pra etapas do GA4 com comparação entre
 * dispositivos (os recortes vêm do GA4).
 */

import { type MeasuredMetric, UX_METRICS } from "./metrics.ts";
import type { FunnelSegment, SegmentDim, UxDevice } from "./types.ts";

/** Abaixo disso, o recorte não entra na conta de "se repete". */
const MIN_CUT_SAMPLE = 300;

export interface SegmentCut {
  dim: SegmentDim;
  key: string;
  /** Denominador e taxa no dispositivo da oportunidade. */
  n: number;
  rate: number;
  /** Denominador e taxa no dispositivo de comparação. */
  comp_n: number;
  comp_rate: number;
  /** Fatia do denominador do dispositivo neste recorte (0–1). */
  share: number;
  comp_share: number;
}

export interface Drilldown {
  device: UxDevice;
  comp_device: UxDevice;
  cuts: SegmentCut[];
  /**
   * Por dimensão: em quantos recortes com amostra o gap aponta pro mesmo
   * lado do gap total, e de quantos.
   */
  consistency: Partial<Record<SegmentDim, { same: number; total: number }>>;
  /**
   * Gap total e gap com o dispositivo na mistura de canais (e de nova ×
   * recorrente) da comparação, em pp. NULL = sem recorte pra ajustar.
   */
  gap_pp: number;
  mix_adjusted_gap_pp: Partial<Record<"canal" | "visitante", number>>;
}

const PLATFORM: Record<UxDevice, string> = {
  mobile: "web_mobile",
  desktop: "web_desktop",
};

const ADJUSTABLE: Array<"canal" | "visitante"> = ["canal", "visitante"];

export function drilldown(
  measured: MeasuredMetric | null | undefined,
  segments: FunnelSegment[] | undefined,
): Drilldown | null {
  if (!measured?.comp || measured.gap_pp == null) return null;
  const def = UX_METRICS[measured.key];
  if (def.source !== "ga4" || !def.from || !def.to) return null;
  if (!segments || segments.length === 0) return null;

  const pick = (platform: string, dim: SegmentDim) => {
    const out = new Map<string, { n: number; hits: number }>();
    for (const s of segments) {
      if (s.platform !== platform || s.dim !== dim) continue;
      const count = (e?: string) =>
        s.steps.find((x) => x.event === e)?.count ?? 0;
      out.set(s.key, { n: count(def.from), hits: count(def.to) });
    }
    return out;
  };

  const cuts: SegmentCut[] = [];
  const consistency: Drilldown["consistency"] = {};
  const adjusted: Drilldown["mix_adjusted_gap_pp"] = {};
  const sign = Math.sign(measured.gap_pp);
  for (const dim of ["canal", "visitante", "dia"] as SegmentDim[]) {
    const mine = pick(PLATFORM[measured.device], dim);
    const theirs = pick(PLATFORM[measured.comp.device], dim);
    const total = (m: Map<string, { n: number }>) =>
      [...m.values()].reduce((a, v) => a + v.n, 0);
    const myTotal = total(mine);
    const theirTotal = total(theirs);
    if (myTotal === 0 || theirTotal === 0) continue;
    const dimCuts: SegmentCut[] = [];
    for (const [key, a] of mine) {
      const b = theirs.get(key);
      if (!b || a.n <= 0 || b.n <= 0) continue;
      dimCuts.push({
        dim,
        key,
        n: a.n,
        rate: a.hits / a.n,
        comp_n: b.n,
        comp_rate: b.hits / b.n,
        share: a.n / myTotal,
        comp_share: b.n / theirTotal,
      });
    }
    dimCuts.sort((x, y) =>
      dim === "dia" ? x.key.localeCompare(y.key) : y.n - x.n,
    );
    cuts.push(...dimCuts);

    const sampled = dimCuts.filter(
      (c) => c.n >= MIN_CUT_SAMPLE && c.comp_n >= MIN_CUT_SAMPLE,
    );
    if (sampled.length > 0) {
      consistency[dim] = {
        same: sampled.filter((c) => Math.sign(c.comp_rate - c.rate) === sign)
          .length,
        total: sampled.length,
      };
    }

    if ((ADJUSTABLE as SegmentDim[]).includes(dim) && dimCuts.length > 0) {
      const weight = dimCuts.reduce((a, c) => a + c.comp_share, 0);
      if (weight > 0) {
        const rate =
          dimCuts.reduce((a, c) => a + c.comp_share * c.rate, 0) / weight;
        adjusted[dim as "canal" | "visitante"] = round2(
          (measured.comp.rate - rate) * 100,
        );
      }
    }
  }
  if (cuts.length === 0) return null;
  return {
    device: measured.device,
    comp_device: measured.comp.device,
    cuts,
    consistency,
    gap_pp: measured.gap_pp,
    mix_adjusted_gap_pp: adjusted,
  };
}

/**
 * Quanto do gap o mix de tráfego explica, de 0 a 1, pela dimensão que mais
 * explica. NULL = sem ajuste possível. Mix que AUMENTA o gap conta como 0.
 */
export function mixExplainedShare(
  d: Drilldown,
): { dim: "canal" | "visitante"; share: number } | null {
  if (d.gap_pp === 0) return null;
  let best: { dim: "canal" | "visitante"; share: number } | null = null;
  for (const dim of ADJUSTABLE) {
    const adj = d.mix_adjusted_gap_pp[dim];
    if (adj == null) continue;
    const share = Math.min(1, Math.max(0, (d.gap_pp - adj) / d.gap_pp));
    if (!best || share > best.share) best = { dim, share };
  }
  return best;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Os recortes em texto curto pro prompt: viu produto → carrinho no celular x
 * computador, por canal e por nova × recorrente, com a fatia de cada recorte.
 * Sem isto o modelo culpava a página por um gap que era o tráfego.
 */
export function segmentsForPrompt(
  segments: FunnelSegment[] | undefined,
  windowDays: number,
): string[] {
  if (!segments || segments.length === 0) return [];
  const lines: string[] = [
    `## Recortes do GA4 (viu produto → carrinho; usuárias, ${windowDays} dias; % = fatia de quem viu produto)`,
  ];
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  for (const dim of ["canal", "visitante"] as const) {
    const rows = new Map<
      string,
      Partial<Record<"web_mobile" | "web_desktop", { n: number; rate: number }>>
    >();
    const totals = { web_mobile: 0, web_desktop: 0 };
    for (const s of segments) {
      if (s.dim !== dim) continue;
      if (s.platform !== "web_mobile" && s.platform !== "web_desktop") continue;
      const n = s.steps.find((x) => x.event === "view_item")?.count ?? 0;
      const hits = s.steps.find((x) => x.event === "add_to_cart")?.count ?? 0;
      if (n <= 0) continue;
      totals[s.platform] += n;
      const row = rows.get(s.key) ?? {};
      row[s.platform] = { n, rate: hits / n };
      rows.set(s.key, row);
    }
    const sorted = [...rows.entries()].sort(
      (a, b) => (b[1].web_mobile?.n ?? 0) - (a[1].web_mobile?.n ?? 0),
    );
    if (sorted.length === 0) continue;
    lines.push(
      dim === "canal"
        ? "- por canal de aquisição (1º toque):"
        : "- usuária nova (1º toque na janela) × recorrente:",
    );
    for (const [key, row] of sorted) {
      const cell = (p: "web_mobile" | "web_desktop", word: string) => {
        const v = row[p];
        return v
          ? `${word} ${pct(v.rate)} (${v.n}, ${pct(v.n / Math.max(1, totals[p]))})`
          : `${word} —`;
      };
      lines.push(
        `  - ${key}: ${cell("web_mobile", "celular")} | ${cell("web_desktop", "computador")}`,
      );
    }
  }
  return lines;
}

// ── O segmento que a oportunidade culpa ──────────────────────────────────────

/**
 * O segmento que a oportunidade culpa, contra o resto do mesmo recorte. Em
 * 15/11 (numa loja) a oportunidade "a mídia paga traz gente que não chega
 * ao carrinho" ganhou a hipótese "o pop-up de newsletter rouba a atenção" — um
 * pop-up que abre pra todo mundo, que não explica por que um canal converte
 * menos. Estes números vão pra confiabilidade e pro prompt das hipóteses.
 */
export type FunnelSegmentList = FunnelSegment[] | undefined;

export interface SegmentPremise {
  dim: "canal" | "visitante";
  key: string;
  device: UxDevice;
  /** A etapa no segmento e no resto do recorte, no dispositivo. */
  rate: number;
  n: number;
  rest_rate: number;
  rest_n: number;
  /** O mesmo no dispositivo de comparação. NULL = sem comparação. */
  comp_device: UxDevice | null;
  comp_rate: number | null;
  comp_rest_rate: number | null;
}

/** Resposta do modelo → segmento que existe nos recortes, ou null. */
export function parseSegmentRef(
  raw: unknown,
  segments: FunnelSegment[] | undefined,
): { dim: "canal" | "visitante"; key: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const dim = r.dim === "canal" || r.dim === "visitante" ? r.dim : null;
  const key = String(r.key ?? "").trim();
  if (!dim || !key) return null;
  return (segments ?? []).some((s) => s.dim === dim && s.key === key)
    ? { dim, key }
    : null;
}

export function segmentPremise(
  measured: MeasuredMetric | null | undefined,
  segments: FunnelSegment[] | undefined,
  seg: { dim: "canal" | "visitante"; key: string } | null | undefined,
  /** Comparar com este dispositivo quando a métrica não tem comparação. */
  compDevice?: UxDevice,
): SegmentPremise | null {
  if (!measured || !seg || !segments?.length) return null;
  const def = UX_METRICS[measured.key];
  if (def.source !== "ga4" || !def.from || !def.to) return null;
  const split = (device: UxDevice) => {
    let n = 0;
    let hits = 0;
    let restN = 0;
    let restHits = 0;
    for (const s of segments) {
      if (s.dim !== seg.dim || s.platform !== PLATFORM[device]) continue;
      const c = (e?: string) => s.steps.find((x) => x.event === e)?.count ?? 0;
      if (s.key === seg.key) {
        n += c(def.from);
        hits += c(def.to);
      } else {
        restN += c(def.from);
        restHits += c(def.to);
      }
    }
    return n > 0 && restN > 0
      ? { n, rate: hits / n, restN, restRate: restHits / restN }
      : null;
  };
  const here = split(measured.device);
  if (!here) return null;
  const otherDevice = measured.comp?.device ?? compDevice ?? null;
  const comp = otherDevice ? split(otherDevice) : null;
  return {
    dim: seg.dim,
    key: seg.key,
    device: measured.device,
    rate: here.rate,
    n: here.n,
    rest_rate: here.restRate,
    rest_n: here.restN,
    comp_device: comp ? otherDevice : null,
    comp_rate: comp?.rate ?? null,
    comp_rest_rate: comp?.restRate ?? null,
  };
}
