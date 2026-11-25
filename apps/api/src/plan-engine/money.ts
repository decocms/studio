/**
 * A conta do dinheiro de cada hipótese.
 *
 * Regra dos relatórios, que vale aqui também: a promessa é um delta PEQUENO e
 * nomeado sobre uma base nomeada, e o gap inteiro só aparece como teto. O
 * modelo propõe os termos; a multiplicação é nossa — LLM erra aritmética com
 * confiança, e um R$ errado na tela é pior que nenhum.
 */

import type { MoneyEstimate, RevenueBase } from "./types.ts";

/**
 * Acima disso o delta deixa de ser "uma hipótese de UX" e vira promessa de
 * milagre. Os melhores resultados publicados de mudança de PDP ficam em 1–3 pp
 * numa etapa do funil.
 */
export const MAX_DELTA_PP = 5;

export type MoneyTerms = Omit<MoneyEstimate, "monthly_value">;

/** base × delta (pp) × valor por evento × fração do canal, por mês. */
export function monthlyValue(terms: MoneyTerms): number {
  return (
    Math.round(
      terms.base *
        (terms.delta_pp / 100) *
        terms.value_per_event *
        terms.channel_share *
        100,
    ) / 100
  );
}

/** Problemas que impedem a conta de ir pra tela. Vazio = conta válida. */
export function moneyProblems(terms: Partial<MoneyTerms>): string[] {
  const problems: string[] = [];
  const finite = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v);
  if (!terms.assumption?.trim()) problems.push("sem premissa escrita");
  if (!terms.base_label?.trim()) problems.push("base sem nome");
  if (!terms.value_label?.trim()) problems.push("valor por evento sem nome");
  if (!finite(terms.base) || terms.base <= 0)
    problems.push("base precisa ser > 0");
  if (!finite(terms.delta_pp) || terms.delta_pp <= 0) {
    problems.push("delta precisa ser > 0");
  } else if (terms.delta_pp > MAX_DELTA_PP) {
    problems.push(
      `delta de ${terms.delta_pp} pp passa do teto de ${MAX_DELTA_PP} pp`,
    );
  }
  if (!finite(terms.value_per_event) || terms.value_per_event <= 0) {
    problems.push("valor por evento precisa ser > 0");
  }
  if (
    !finite(terms.channel_share) ||
    terms.channel_share <= 0 ||
    terms.channel_share > 1
  ) {
    problems.push("fração do canal fora de (0, 1]");
  }
  if (
    terms.ceiling_monthly != null &&
    (!finite(terms.ceiling_monthly) || terms.ceiling_monthly < 0)
  ) {
    problems.push("teto inválido");
  }
  return problems;
}

/**
 * Termos crus do modelo → estimativa com o valor calculado por nós, ou os
 * problemas. Um teto MENOR que o próprio valor é contradição (o modelo trocou
 * as bolas); o teto é descartado em vez de a hipótese inteira.
 */
export function buildMoneyEstimate(
  raw: unknown,
):
  | { money: MoneyEstimate; problems: [] }
  | { money: null; problems: string[] } {
  if (!raw || typeof raw !== "object") {
    return { money: null, problems: ["sem conta do dinheiro"] };
  }
  const r = raw as Record<string, unknown>;
  const num = (v: unknown) =>
    typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  const terms: MoneyTerms = {
    assumption: String(r.assumption ?? ""),
    base: num(r.base),
    base_label: String(r.base_label ?? ""),
    delta_pp: num(r.delta_pp),
    value_per_event: num(r.value_per_event),
    value_label: String(r.value_label ?? ""),
    ceiling_monthly: r.ceiling_monthly == null ? null : num(r.ceiling_monthly),
    channel_share: r.channel_share == null ? 1 : num(r.channel_share),
  };
  const problems = moneyProblems(terms);
  if (problems.length > 0) return { money: null, problems };
  const value = monthlyValue(terms);
  const ceiling =
    terms.ceiling_monthly != null && terms.ceiling_monthly >= value
      ? terms.ceiling_monthly
      : null;
  return {
    money: { ...terms, ceiling_monthly: ceiling, monthly_value: value },
    problems: [],
  };
}

/**
 * A base da conta não pode passar de quem existe na etapa. O modelo escrevia a
 * base de cabeça (às vezes o site todo, às vezes com o app junto); a métrica
 * medida diz quantas pessoas chegam na etapa no dispositivo, por mês. Base
 * menor que isso fica (o problema pode ser de um recorte, como produto
 * esgotado); maior é trocada pela medida, e aí a fração do canal vira 1,
 * porque a medida já é só o site.
 */
export function capMoneyBase(
  money: MoneyEstimate | null,
  measured: { n: number; window_days: number; label: string } | null,
  deviceWord: string,
): MoneyEstimate | null {
  if (!money || !measured || !(measured.n > 0) || !(measured.window_days > 0)) {
    return money;
  }
  const monthly = Math.round((measured.n * 30) / measured.window_days);
  if (money.base * money.channel_share <= monthly * 1.05) return money;
  const step = measured.label.split(" → ")[0];
  const terms: MoneyTerms = {
    ...money,
    base: monthly,
    base_label: `pessoas em "${step}" no ${deviceWord} por mês (medido: ${measured.n.toLocaleString("pt-BR")} em ${measured.window_days} dias × 30/${measured.window_days}; o modelo tinha ${Math.round(money.base).toLocaleString("pt-BR")})`,
    channel_share: 1,
  };
  const value = monthlyValue(terms);
  return {
    ...terms,
    ceiling_monthly:
      terms.ceiling_monthly != null && terms.ceiling_monthly >= value
        ? terms.ceiling_monthly
        : null,
    monthly_value: value,
  };
}

// ── A conta da perda medida (losses.ts) ──────────────────────────────────────

/**
 * O canal de venda do site na VTEX: o que se chama "Principal" (ou o id 1, o
 * padrão da VTEX). O app vende por outro canal e não passa por estas páginas.
 */
export function siteChannel(
  revenue: RevenueBase | null | undefined,
): RevenueBase["by_channel"][number] | null {
  const channels = revenue?.by_channel ?? [];
  return (
    channels.find((c) => /principal|site|web|e-?commerce/i.test(c.channel)) ??
    channels.find((c) => /\(1\)$/.test(c.channel)) ??
    null
  );
}

const brl = (v: number) =>
  `R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pctWord = (r: number) =>
  `${(r * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;

/**
 * A conta inteira de uma perda medida, sem nenhum termo do modelo além do
 * delta (que fica entre MIN_LOSS_DELTA e o teto da própria perda):
 * - base: quem está na etapa, por mês, medido;
 * - valor por evento: ticket do canal do site × quantas de quem chega ao
 *   numerador da etapa compram (GA4, mesmo dispositivo);
 * - teto: a perda inteira (o gap, ou a distância do segmento pro resto).
 * NULL = falta o ticket do site ou a taxa de compra.
 */
export function lossMoney(input: {
  /** Quem está na etapa na janela, e a janela em dias. */
  n: number;
  window_days: number;
  step: string;
  deviceWord: string;
  /** O delta pedido (pp); é limitado aqui. */
  delta_pp: number;
  /** A perda inteira em pp (gap ou distância pro resto). NULL = absoluta. */
  gap_pp: number | null;
  /** Quantas de quem passa da etapa compram. */
  purchase: { rate: number; event: string } | null;
  revenue: RevenueBase | null | undefined;
  assumption: string;
}): MoneyEstimate | null {
  const channel = siteChannel(input.revenue);
  if (!channel || !(channel.avg_ticket > 0)) return null;
  if (!input.purchase || !(input.purchase.rate > 0)) return null;
  if (!(input.n > 0) || !(input.window_days > 0)) return null;
  const cap = Math.min(
    MAX_LOSS_DELTA,
    input.gap_pp != null && input.gap_pp > 0 ? input.gap_pp : MAX_LOSS_DELTA,
  );
  const asked = Number.isFinite(input.delta_pp) ? input.delta_pp : 0;
  const delta =
    Math.round(Math.min(cap, Math.max(MIN_LOSS_DELTA, asked)) * 100) / 100;
  if (!(delta > 0)) return null;
  const base = Math.round((input.n * 30) / input.window_days);
  const valuePerEvent =
    Math.round(channel.avg_ticket * input.purchase.rate * 100) / 100;
  const terms: MoneyTerms = {
    assumption:
      input.assumption.trim() ||
      `+${delta.toLocaleString("pt-BR")} pp em "${input.step}" no ${input.deviceWord}`,
    base,
    base_label: `pessoas em "${input.step.split(" → ")[0]}" no ${input.deviceWord} por mês (medido: ${Math.round(input.n).toLocaleString("pt-BR")} em ${input.window_days} dias × 30/${input.window_days})`,
    delta_pp: delta,
    value_per_event: valuePerEvent,
    value_label: `ticket do site ${brl(channel.avg_ticket)} (${channel.channel}) × ${pctWord(input.purchase.rate)} de quem chega a ${input.purchase.event} compra (GA4, ${input.deviceWord})`,
    channel_share: 1,
    ceiling_monthly: null,
  };
  const value = monthlyValue(terms);
  const ceiling =
    input.gap_pp != null && input.gap_pp > 0
      ? monthlyValue({ ...terms, delta_pp: input.gap_pp })
      : null;
  return {
    ...terms,
    ceiling_monthly: ceiling != null && ceiling >= value ? ceiling : null,
    monthly_value: value,
  };
}

/** O delta de uma perda medida fica nesta faixa (e nunca passa da própria perda). */
export const MIN_LOSS_DELTA = 0.3;
export const MAX_LOSS_DELTA = 3;
