import { describe, expect, test } from "bun:test";
import { evidence } from "./fixtures/evidence.ts";
import { measureMetric, parseMetricRef } from "./metrics.ts";

describe("measureMetric", () => {
  test("GA4 step with comparison: rate, sample and gap in pp", () => {
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

  test("without GA4, viewed -> cart falls back to the PDP funnel and says so", () => {
    const m = measureMetric(evidence({ platform_funnel: [] }), {
      key: "produto_carrinho",
      device: "mobile",
      compare_to: "desktop",
    });
    expect(m?.key).toBe("pdp_carrinho");
    expect(m?.fallback).toBe(true);
    expect(m?.rate).toBeCloseTo(0.075);
    // Desktop has no PDP funnel in this evidence: no comparison.
    expect(m?.comp).toBeNull();
    expect(m?.gap_pp).toBeNull();
  });

  test("a step missing from the data: null", () => {
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
  test("an unknown key is invalid", () => {
    expect(parseMetricRef({ key: "conversao" }, "mobile")).toBeNull();
    expect(parseMetricRef(null, "mobile")).toBeNull();
  });

  test("without a device, uses the opportunity's; comparing with itself becomes null", () => {
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
