/**
 * The money calculation for each hypothesis: a small named delta over a named
 * base, with the whole gap only as a cap. The model proposes the terms; the
 * arithmetic is ours.
 */

import type { MoneyEstimate, RevenueBase } from "./types.ts";

/** Above this the delta stops being a UX hypothesis and becomes a miracle promise. */
export const MAX_DELTA_PP = 5;

export type MoneyTerms = Omit<MoneyEstimate, "monthly_value">;

/** base × delta (pp) × value per event × channel fraction, per month. */
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

/** Problems that keep the calculation off the screen. Empty = valid calculation. */
function moneyProblems(terms: Partial<MoneyTerms>): string[] {
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

/** Raw model terms → an estimate with the value computed by us, or the problems. */
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
 * The base cannot exceed who exists in the stage: a larger one is replaced by
 * the measure (and the channel fraction becomes 1); a smaller one stays.
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

// ── The measured loss calculation (losses.ts) ──────────────────────────────

/** The site's sales channel in VTEX ("Principal" or id 1); the app sells through another. */
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
 * The whole calculation of a measured loss, with only the delta from the model.
 * NULL = the site ticket or the purchase rate is missing.
 */
export function lossMoney(input: {
  /** Who is in the stage in the window, and the window in days. */
  n: number;
  window_days: number;
  step: string;
  deviceWord: string;
  /** The requested delta (pp); it is clamped here. */
  delta_pp: number;
  /** The whole loss in pp (gap or distance to the rest). NULL = absolute. */
  gap_pp: number | null;
  /** How many of those who pass the stage buy. */
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

/** A measured loss's delta stays in this range (and never exceeds the loss itself). */
const MIN_LOSS_DELTA = 0.3;
const MAX_LOSS_DELTA = 3;
