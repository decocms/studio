import { describe, expect, test } from "bun:test";
import { trafficCheck, zAgainst } from "./data-checks.ts";
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

  test("a small desktop segment that looks like the rest does not refute: within noise", () => {
    const segments = [
      seg("social_pago", "web_mobile", 206_244, 10_442),
      seg("outros", "web_mobile", 200_254, 31_929),
      seg("social_pago", "web_desktop", 40, 10),
      seg("outros", "web_desktop", 38_538, 9_389),
    ];
    const out = trafficCheck(
      h,
      { drilldown: null, metric, measured },
      "t",
      segments,
    );
    expect(out.verdict).toBe("inconclusiva");
    expect(out.runs[0]!.observed).toContain("não sai do ruído da amostra");
  });

  test("a small desktop segment that looks worse does not confirm: within noise", () => {
    const segments = [
      seg("social_pago", "web_mobile", 206_244, 10_442),
      seg("outros", "web_mobile", 200_254, 31_929),
      seg("social_pago", "web_desktop", 20, 3),
      seg("outros", "web_desktop", 38_538, 9_389),
    ];
    const out = trafficCheck(
      h,
      { drilldown: null, metric, measured },
      "t",
      segments,
    );
    expect(out.verdict).toBe("inconclusiva");
  });
});

describe("zAgainst", () => {
  test("large samples separate a small gap; small ones do not", () => {
    expect(zAgainst(0.2, 100_000, 0.21, 100_000)).toBeLessThan(-1.645);
    expect(zAgainst(0.2, 50, 0.21, 50)).toBeGreaterThan(-1.645);
  });

  test("against a share of the other rate, and with no variance", () => {
    expect(zAgainst(0.24, 10_000, 0.25, 10_000, 0.85)).toBeGreaterThan(1.645);
    expect(zAgainst(0, 10, 0, 10)).toBe(0);
    expect(zAgainst(1, 10, 0, 10)).toBe(Infinity);
  });
});
