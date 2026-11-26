import { describe, expect, test } from "bun:test";
import { evidence } from "./fixtures/evidence.ts";
import { measureMetric, type UxMetricRef } from "./metrics.ts";
import { assessReliability, premiseChecks } from "./reliability.ts";
import type { DiagnosisEvidence } from "./types.ts";

const ref: UxMetricRef = {
  key: "produto_carrinho",
  device: "mobile",
  compare_to: "desktop",
};

function assess(ev: DiagnosisEvidence, metric: UxMetricRef | null = ref) {
  return assessReliability({
    evidence: ev,
    device: "mobile",
    sources: [{ source: "ga4", metric: "x", value: "1", window: null }],
    metric,
    measured: metric ? measureMetric(ev, metric) : null,
  });
}

const codes = (r: ReturnType<typeof assess>) =>
  r.checks.map((c) => `${c.code}:${c.severity}`);

describe("assessReliability", () => {
  test("large sample and difference outside the noise: high, only the window warning", () => {
    const r = assess(evidence());
    expect(r.level).toBe("alta");
    expect(codes(r)).toEqual(["amostra:ok", "ruido:ok", "janela:info"]);
  });

  test("difference within the noise blocks", () => {
    const ev = evidence({
      platform_funnel: [
        {
          platform: "web_mobile",
          steps: [
            { event: "view_item", count: 3_000 },
            { event: "add_to_cart", count: 300 },
          ],
        },
        {
          platform: "web_desktop",
          steps: [
            { event: "view_item", count: 3_000 },
            { event: "add_to_cart", count: 320 },
          ],
        },
      ],
    });
    const r = assess(ev);
    expect(r.level).toBe("baixa");
    expect(codes(r)).toContain("ruido:bloqueia");
  });

  // A "mobile loses" claim with mobile ahead of desktop must block, not rate "medium".
  test("the device the opportunity says loses is BETTER: blocks", () => {
    const ev = evidence({
      platform_funnel: [
        {
          platform: "web_mobile",
          steps: [
            { event: "view_item", count: 618_520 },
            { event: "add_to_cart", count: 233_843 },
          ],
        },
        {
          platform: "web_desktop",
          steps: [
            { event: "view_item", count: 190_939 },
            { event: "add_to_cart", count: 44_367 },
          ],
        },
      ],
    });
    const r = assess(ev);
    expect(r.level).toBe("baixa");
    const sign = r.checks.find((c) => c.code === "ruido");
    expect(sign?.severity).toBe("bloqueia");
    expect(sign?.text).toContain("o celular está MELHOR");
  });

  test("off the PDP, GA4 'viewed product' x page visitors is not a contradiction", () => {
    const ev = evidence({ page_type: "categoria" });
    const big = {
      ...ev,
      platform_funnel: [
        {
          platform: "web_mobile",
          steps: [
            { event: "view_item", count: 5_000_000 },
            { event: "add_to_cart", count: 500_000 },
          ],
        },
      ],
    };
    const tracking = assess(big, { ...ref, compare_to: null }).checks.filter(
      (c) => c.code === "tracking",
    );
    expect(tracking.map((c) => c.text).join(" ")).not.toContain(
      "visitantes da PDP",
    );
  });

  test("minimum sample blocks; small asks for attention", () => {
    const funnel = (n: number) => [
      {
        platform: "web_mobile",
        steps: [
          { event: "view_item", count: n },
          { event: "add_to_cart", count: Math.round(n / 10) },
        ],
      },
    ];
    const one = { ...ref, compare_to: null };
    expect(assess(evidence({ platform_funnel: funnel(300) }), one).level).toBe(
      "baixa",
    );
    const mid = assess(evidence({ platform_funnel: funnel(1_000) }), one);
    expect(mid.level).toBe("media");
    expect(codes(mid)).toContain("amostra:atencao");
  });

  test("no metric, or a metric missing from the data: attention", () => {
    expect(codes(assess(evidence(), null))).toContain("metrica:atencao");
    const missing = assess(evidence({ platform_funnel: [] }), {
      key: "checkout_compra",
      device: "mobile",
      compare_to: null,
    });
    expect(missing.level).toBe("media");
  });

  test("a cited source that failed asks for attention; an uncited one does not", () => {
    const r = assess(
      evidence({
        gaps: [
          { source: "bigquery", error: "timeout" },
          { source: "benchmark", error: "nada abriu" },
        ],
      }),
    );
    expect(r.checks.filter((c) => c.code === "fonte")).toHaveLength(1);
    expect(r.level).toBe("media");
  });

  test("tracking: more cart than product viewed, and GA4 x Deco Analytics of very different sizes", () => {
    const ev = evidence({
      platform_funnel: [
        {
          platform: "web_mobile",
          steps: [
            { event: "view_item", count: 500_000 },
            { event: "add_to_cart", count: 600_000 },
          ],
        },
      ],
    });
    const tracking = assess(ev, { ...ref, compare_to: null }).checks.filter(
      (c) => c.code === "tracking",
    );
    expect(tracking).toHaveLength(2);
  });
});

describe("segment premise", () => {
  const base = {
    dim: "canal" as const,
    key: "midia_paga",
    device: "mobile" as const,
    n: 160_653,
    rest_n: 72_556,
    comp_device: "desktop" as const,
  };

  test("another store: paid media worse than the rest, and the screen difference is larger there", () => {
    const out = premiseChecks({
      ...base,
      rate: 0.03,
      rest_rate: 0.0697,
      comp_rate: 0.109,
      comp_rest_rate: 0.168,
    });
    expect(out.map((c) => c.severity)).toEqual(["info"]);
    expect(out[0]!.text).toContain(
      "mídia paga: 3% no celular, contra 7% de os outros canais",
    );
  });

  test("a segment that does not convert less blocks", () => {
    const out = premiseChecks({
      ...base,
      rate: 0.08,
      rest_rate: 0.07,
      comp_rate: 0.1,
      comp_rest_rate: 0.1,
    });
    expect(out[0]!.severity).toBe("bloqueia");
  });

  test("mobile loses just as much outside the segment: the screen difference is not the segment's", () => {
    const out = premiseChecks({
      ...base,
      rate: 0.03,
      rest_rate: 0.05,
      comp_rate: 0.06,
      comp_rest_rate: 0.1,
    });
    expect(out.map((c) => c.severity)).toEqual(["info", "atencao"]);
    expect(out[1]!.text).toContain("vale pra todos");
  });
});
