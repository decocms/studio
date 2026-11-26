import { describe, expect, test } from "bun:test";
import { evidence, sampleFunnel, sampleSegments } from "./fixtures/evidence.ts";
import { measureMetric } from "./metrics.ts";
import { assessReliability } from "./reliability.ts";
import {
  drilldown,
  mixExplainedShare,
  parseSegmentRef,
  segmentPremise,
  segmentsForPrompt,
} from "./segments.ts";

const sample = evidence({
  platform_funnel: sampleFunnel,
  segments: sampleSegments,
  pdp_behaviour: [],
});
const ref = {
  key: "produto_carrinho" as const,
  device: "mobile" as const,
  compare_to: "desktop" as const,
};

describe("drilldown (fashion store, one week)", () => {
  const m = measureMetric(sample, ref);
  const d = drilldown(m, sample.segments);

  test("total gap and gap with the desktop channel mix", () => {
    expect(m?.gap_pp).toBe(12.98);
    // With the desktop channel mix mobile would reach ~13%: the mix explains part of the gap, most remains
    expect(d?.mix_adjusted_gap_pp.canal).toBeCloseTo(10.4, 0);
    const mix = d ? mixExplainedShare(d) : null;
    expect(mix?.dim).toBe("canal");
    expect(mix?.share).toBeGreaterThan(0.15);
    expect(mix?.share).toBeLessThan(0.3);
  });

  test("repeats: desktop wins in almost every channel with a sample", () => {
    // "outros" and "social" are the channels where mobile does better
    expect(d?.consistency.canal).toEqual({ same: 5, total: 7 });
    expect(d?.consistency.visitante).toEqual({ same: 2, total: 2 });
  });

  test("each slice keeps both rates and the share", () => {
    const social = d?.cuts.find((c) => c.key === "social_pago");
    expect(social?.share).toBeCloseTo(0.5, 1);
    expect(social?.rate).toBeCloseTo(0.0506, 3);
    expect(social?.comp_rate).toBeCloseTo(0.0835, 3);
  });

  test("reliability shows the fair comparison and the repetition", () => {
    const r = assessReliability({
      evidence: sample,
      device: "mobile",
      sources: [],
      metric: ref,
      measured: m,
      drilldown: d,
    });
    const codes = r.checks.map((c) => `${c.code}:${c.severity}`);
    expect(codes).toContain("comparacao:ok");
    expect(codes).toContain("recorte:ok");
    expect(r.level).toBe("alta");
  });
});

describe("drilldown with nothing to slice", () => {
  test("Deco Analytics stage, without comparison or without slices: null", () => {
    const pdp = measureMetric(sample, { ...ref, key: "pdp_carrinho" });
    expect(drilldown(pdp, sample.segments)).toBeNull();
    const alone = measureMetric(sample, { ...ref, compare_to: null });
    expect(drilldown(alone, sample.segments)).toBeNull();
    expect(drilldown(measureMetric(sample, ref), [])).toBeNull();
  });
});

describe("mix that explains the gap", () => {
  test("the gap disappears when mobile has desktop's mix: attention", () => {
    // Each channel converts the same on both screens; mobile just has more weak-channel traffic
    const seg = (key: string, platform: string, n: number, rate: number) => ({
      dim: "canal" as const,
      key,
      platform,
      steps: [
        { event: "view_item", count: n },
        { event: "add_to_cart", count: Math.round(n * rate) },
      ],
    });
    const segments = [
      seg("forte", "web_mobile", 10_000, 0.2),
      seg("fraco", "web_mobile", 90_000, 0.05),
      seg("forte", "web_desktop", 9_000, 0.2),
      seg("fraco", "web_desktop", 1_000, 0.05),
    ];
    const ev = evidence({
      segments,
      platform_funnel: [
        {
          platform: "web_mobile",
          steps: [
            { event: "view_item", count: 100_000 },
            { event: "add_to_cart", count: 6_500 },
          ],
        },
        {
          platform: "web_desktop",
          steps: [
            { event: "view_item", count: 10_000 },
            { event: "add_to_cart", count: 1_850 },
          ],
        },
      ],
    });
    const m = measureMetric(ev, ref);
    const d = drilldown(m, segments);
    expect(d ? mixExplainedShare(d)?.share : null).toBe(1);
    const r = assessReliability({
      evidence: ev,
      device: "mobile",
      sources: [],
      metric: ref,
      measured: m,
      drilldown: d,
    });
    expect(r.checks.find((c) => c.code === "comparacao")?.severity).toBe(
      "atencao",
    );
    expect(r.level).toBe("media");
  });
});

describe("segmentsForPrompt", () => {
  test("one line per channel, largest mobile share first", () => {
    const lines = segmentsForPrompt(sampleSegments, 7);
    expect(lines[0]).toContain("Recortes do GA4");
    const firstChannel = lines.findIndex((l) =>
      l.includes("canal de aquisição"),
    );
    expect(lines[firstChannel + 1]).toContain("social_pago: celular 5.1%");
    expect(lines.some((l) => l.includes("recorrente"))).toBe(true);
    expect(segmentsForPrompt(undefined, 7)).toEqual([]);
  });
});

describe("segmentPremise", () => {
  // Viewed product → cart by channel: paid media vs the rest, on both screens
  const seg = (key: string, platform: string, n: number, hits: number) => ({
    dim: "canal" as const,
    key,
    platform,
    steps: [
      { event: "view_item", count: n },
      { event: "add_to_cart", count: hits },
    ],
  });
  const cuts = [
    seg("midia_paga", "web_mobile", 160_653, 4_820),
    seg("outros", "web_mobile", 72_556, 5_060),
    seg("midia_paga", "web_desktop", 10_178, 1_109),
    seg("outros", "web_desktop", 6_941, 1_169),
  ];
  const ev = evidence({
    segments: cuts,
    platform_funnel: [
      {
        platform: "web_mobile",
        steps: [
          { event: "view_item", count: 233_209 },
          { event: "add_to_cart", count: 9_880 },
        ],
      },
      {
        platform: "web_desktop",
        steps: [
          { event: "view_item", count: 17_119 },
          { event: "add_to_cart", count: 2_278 },
        ],
      },
    ],
  });
  const m = measureMetric(ev, ref);

  test("paid media converts 3% on mobile against 7% for the rest", () => {
    const p = segmentPremise(m, cuts, { dim: "canal", key: "midia_paga" });
    expect(p?.rate).toBeCloseTo(0.03, 3);
    expect(p?.rest_rate).toBeCloseTo(0.0697, 3);
    expect(p?.comp_rate).toBeCloseTo(0.109, 3);
    expect(p?.comp_rest_rate).toBeCloseTo(0.168, 3);
  });

  test("a segment that does not exist in the slices does not count", () => {
    expect(parseSegmentRef({ dim: "canal", key: "tv" }, cuts)).toBeNull();
    expect(parseSegmentRef({ dim: "canal", key: "midia_paga" }, cuts)).toEqual({
      dim: "canal",
      key: "midia_paga",
    });
  });
});
