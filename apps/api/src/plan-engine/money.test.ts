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
  test("reproduz a conta do relatório: 13.800 carrinhos × R$54 ≈ R$745k", () => {
    expect(monthlyValue(terms)).toBe(745_200);
  });

  test("aplica a fração do canal", () => {
    expect(monthlyValue({ ...terms, channel_share: 1 / 3 })).toBe(248_400);
  });
});

describe("buildMoneyEstimate", () => {
  test("recalcula o valor em vez de confiar no do modelo", () => {
    const out = buildMoneyEstimate({ ...terms, monthly_value: 99 });
    expect(out.money?.monthly_value).toBe(745_200);
  });

  test("aceita número como string", () => {
    const out = buildMoneyEstimate({
      ...terms,
      base: "1380000",
      delta_pp: "1",
    });
    expect(out.money?.monthly_value).toBe(745_200);
  });

  test("recusa delta de milagre", () => {
    const out = buildMoneyEstimate({ ...terms, delta_pp: 12 });
    expect(out.money).toBeNull();
    expect(out.problems.join()).toContain("teto");
  });

  test("recusa base sem nome e fração fora de (0,1]", () => {
    const out = buildMoneyEstimate({
      ...terms,
      base_label: "",
      channel_share: 1.5,
    });
    expect(out.problems).toContain("base sem nome");
    expect(out.problems).toContain("fração do canal fora de (0, 1]");
  });

  test("teto menor que o valor é descartado, a hipótese fica", () => {
    const out = buildMoneyEstimate({ ...terms, ceiling_monthly: 1000 });
    expect(out.money?.ceiling_monthly).toBeNull();
    expect(out.money?.monthly_value).toBe(745_200);
  });

  test("sem conta nenhuma", () => {
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

  test("base maior que quem existe na etapa vira a medida, e a fração do canal vira 1", () => {
    const out = capMoneyBase(money, measured, "celular");
    // 50.000 em 7 dias × 30/7 = 214.286 por mês.
    expect(out?.base).toBe(214_286);
    expect(out?.channel_share).toBe(1);
    expect(out?.monthly_value).toBe(115_714.44);
    expect(out?.base_label).toContain("o modelo tinha 1.380.000");
  });

  test("base menor (um recorte) fica como está", () => {
    const small = buildMoneyEstimate({ ...terms, base: 100_000 }).money;
    expect(capMoneyBase(small, measured, "celular")).toBe(small);
  });

  test("sem medida ou sem conta, nada muda", () => {
    expect(capMoneyBase(money, null, "celular")).toBe(money);
    expect(capMoneyBase(null, measured, "celular")).toBeNull();
  });
});
