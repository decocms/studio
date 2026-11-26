import { describe, expect, test } from "bun:test";
import { trafficCheck } from "./data-checks.ts";
import { evidence, sampleFunnel, sampleSegments } from "./fixtures/evidence.ts";
import { measureMetric } from "./metrics.ts";
import { drilldown } from "./segments.ts";

const h = { device: "mobile" as const, confidence: 0.5, verification: null };

describe("trafficCheck", () => {
  test("fashion store, one week: the mix explains ~20% and the gap repeats -> the traffic explanation drops", () => {
    const ev = evidence({
      platform_funnel: sampleFunnel,
      segments: sampleSegments,
    });
    const m = measureMetric(ev, {
      key: "produto_carrinho",
      device: "mobile",
      compare_to: "desktop",
    });
    const out = trafficCheck(
      h,
      { drilldown: drilldown(m, sampleSegments) },
      "t",
    );
    expect(out.verdict).toBe("desmentida");
    expect(out.runs[0]!.check.stage).toBe("data");
    expect(out.summary).toContain("20% explicado");
    expect(out.novas_linhas?.[0]).toContain("procurar a causa na página");
  });

  test("no breakdown: nothing tested (becomes blocked in the cycle)", () => {
    const out = trafficCheck(h, { drilldown: null }, "t");
    expect(out.verdict).toBe("inconclusiva");
    expect(out.runs[0]!.outcome).toBe("nao_testou");
  });

  test("a mix that explains the gap confirms", () => {
    const d = {
      device: "mobile" as const,
      comp_device: "desktop" as const,
      cuts: [],
      consistency: {},
      gap_pp: 10,
      mix_adjusted_gap_pp: { canal: 2 },
    };
    expect(trafficCheck(h, { drilldown: d }, "t").verdict).toBe("confirmada");
  });
});

describe("a segment's traffic (fashion store)", () => {
  const seg = (key: string, platform: string, n: number, hits: number) => ({
    dim: "canal" as const,
    key,
    platform,
    steps: [
      { event: "view_item", count: n },
      { event: "add_to_cart", count: hits },
    ],
  });
  const measured = {
    key: "produto_carrinho" as const,
    label: "viu produto → carrinho",
    source: "ga4" as const,
    device: "mobile" as const,
    n: 406_498,
    hits: 42_371,
    rate: 0.104,
    window_days: 7,
    comp: null,
    gap_pp: null,
  };
  const metric = {
    key: "produto_carrinho" as const,
    device: "mobile" as const,
    compare_to: null,
    segment: { dim: "canal" as const, key: "social_pago" },
  };

  test("paid social converts less on both screens: it is the traffic (confirms)", () => {
    const segments = [
      seg("social_pago", "web_mobile", 206_244, 10_442),
      seg("outros", "web_mobile", 200_254, 31_929),
      seg("social_pago", "web_desktop", 2_468, 206),
      seg("outros", "web_desktop", 38_538, 9_389),
    ];
    const out = trafficCheck(
      h,
      { drilldown: null, metric, measured },
      "t",
      segments,
    );
    expect(out.verdict).toBe("confirmada");
    expect(out.runs[0]!.check.claim).toContain(
      "converte menos que o resto nas duas telas",
    );
  });

  test("on desktop it converts like the rest: it is the mobile experience (disproves)", () => {
    const segments = [
      seg("social_pago", "web_mobile", 206_244, 10_442),
      seg("outros", "web_mobile", 200_254, 31_929),
      seg("social_pago", "web_desktop", 2_468, 610),
      seg("outros", "web_desktop", 38_538, 9_389),
    ];
    const out = trafficCheck(
      h,
      { drilldown: null, metric, measured },
      "t",
      segments,
    );
    expect(out.verdict).toBe("desmentida");
    expect(out.novas_linhas?.[0]).toContain("página do celular");
  });
});
