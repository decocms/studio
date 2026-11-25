import { describe, expect, test } from "bun:test";
import { evidence } from "./fixtures/evidence.ts";
import { measureMetric, parseMetricRef } from "./metrics.ts";

describe("measureMetric", () => {
  test("etapa do GA4 com comparação: taxa, amostra e gap em pp", () => {
    const m = measureMetric(evidence(), {
      key: "produto_carrinho",
      device: "mobile",
      compare_to: "desktop",
    });
    expect(m?.n).toBe(50_000);
    expect(m?.hits).toBe(5_000);
    expect(m?.rate).toBeCloseTo(0.1);
    expect(m?.comp?.rate).toBeCloseTo(0.2);
    expect(m?.gap_pp).toBe(10);
    expect(m?.source).toBe("ga4");
    expect(m?.fallback).toBeUndefined();
  });

  test("sem GA4, viu → carrinho cai pro funil da PDP e avisa", () => {
    const m = measureMetric(evidence({ platform_funnel: [] }), {
      key: "produto_carrinho",
      device: "mobile",
      compare_to: "desktop",
    });
    expect(m?.key).toBe("pdp_carrinho");
    expect(m?.fallback).toBe(true);
    expect(m?.rate).toBeCloseTo(0.075);
    // O desktop não tem funil da PDP nesta evidência: sem comparação.
    expect(m?.comp).toBeNull();
    expect(m?.gap_pp).toBeNull();
  });

  test("etapa que não existe nos dados: null", () => {
    expect(
      measureMetric(evidence({ platform_funnel: [] }), {
        key: "checkout_compra",
        device: "mobile",
        compare_to: null,
      }),
    ).toBeNull();
  });
});

describe("parseMetricRef", () => {
  test("chave desconhecida não vale", () => {
    expect(parseMetricRef({ key: "conversao" }, "mobile")).toBeNull();
    expect(parseMetricRef(null, "mobile")).toBeNull();
  });

  test("sem dispositivo, usa o da oportunidade; comparar consigo mesmo vira null", () => {
    expect(
      parseMetricRef(
        { key: "produto_carrinho", compare_to: "desktop" },
        "desktop",
      ),
    ).toEqual({ key: "produto_carrinho", device: "desktop", compare_to: null });
    expect(parseMetricRef({ key: "pdp_carrinho" }, "ambos")).toEqual({
      key: "pdp_carrinho",
      device: "mobile",
      compare_to: null,
    });
  });
});
