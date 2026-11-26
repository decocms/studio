import { describe, expect, test } from "bun:test";
import { buildMoneyEstimate, capMoneyBase, monthlyValue } from "./money.ts";

const terms = {
  assumption: "1 ponto a mais em viu→carrinho no celular",
  base: 1_380_000,
  base_label: "pessoas que veem produto no celular por mês",
  delta_pp: 1,
  value_per_event: 54,
  value_label: "valor de um carrinho (ticket × carrinho→compra)",
  ceiling_monthly: 5_200_000,
  channel_share: 1,
};

describe("monthlyValue", () => {
  test("reproduces the report's calculation: 13,800 carts × R$54 ≈ R$745k", () => {
    expect(monthlyValue(terms)).toBe(745_200);
  });

  test("applies the channel fraction", () => {
    expect(monthlyValue({ ...terms, channel_share: 1 / 3 })).toBe(248_400);
  });
});

describe("buildMoneyEstimate", () => {
  test("recalculates the value instead of trusting the model's", () => {
    const out = buildMoneyEstimate({ ...terms, monthly_value: 99 });
    expect(out.money?.monthly_value).toBe(745_200);
  });

  test("accepts a number as a string", () => {
    const out = buildMoneyEstimate({
      ...terms,
      base: "1380000",
      delta_pp: "1",
    });
    expect(out.money?.monthly_value).toBe(745_200);
  });

  test("rejects a miracle delta", () => {
    const out = buildMoneyEstimate({ ...terms, delta_pp: 12 });
    expect(out.money).toBeNull();
    expect(out.problems.join()).toContain("teto");
  });

  test("rejects an unnamed base and a fraction outside (0,1]", () => {
    const out = buildMoneyEstimate({
      ...terms,
      base_label: "",
      channel_share: 1.5,
    });
    expect(out.problems).toContain("base sem nome");
    expect(out.problems).toContain("fração do canal fora de (0, 1]");
  });

  test("a ceiling below the value is discarded, the hypothesis stays", () => {
    const out = buildMoneyEstimate({ ...terms, ceiling_monthly: 1000 });
    expect(out.money?.ceiling_monthly).toBeNull();
    expect(out.money?.monthly_value).toBe(745_200);
  });

  test("no calculation at all", () => {
    expect(buildMoneyEstimate(null).problems).toEqual([
      "sem conta do dinheiro",
    ]);
  });
});

describe("capMoneyBase", () => {
  const money = buildMoneyEstimate(terms).money;
  const measured = {
    n: 50_000,
    window_days: 7,
    label: "viu produto → carrinho",
  };

  test("a base larger than who exists at the stage becomes the measure, and the channel fraction becomes 1", () => {
    const out = capMoneyBase(money, measured, "celular");
    // 50,000 in 7 days × 30/7 = 214,286 per month
    expect(out?.base).toBe(214_286);
    expect(out?.channel_share).toBe(1);
    expect(out?.monthly_value).toBe(115_714.44);
    expect(out?.base_label).toContain("o modelo tinha 1.380.000");
  });

  test("a smaller base (a slice) stays as is", () => {
    const small = buildMoneyEstimate({ ...terms, base: 100_000 }).money;
    expect(capMoneyBase(small, measured, "celular")).toBe(small);
  });

  test("without a measure or without a calculation, nothing changes", () => {
    expect(capMoneyBase(money, null, "celular")).toBe(money);
    expect(capMoneyBase(null, measured, "celular")).toBeNull();
  });
});
