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

describe("drilldown (loja de moda, uma semana)", () => {
  const m = measureMetric(sample, ref);
  const d = drilldown(m, sample.segments);

  test("gap total e gap com a mistura de canais do computador", () => {
    expect(m?.gap_pp).toBe(12.98);
    // Com a mistura de canais do computador, o celular iria a ~13%: o mix
    // explica uma parte, a maior parte do gap fica.
    expect(d?.mix_adjusted_gap_pp.canal).toBeCloseTo(10.4, 0);
    const mix = d ? mixExplainedShare(d) : null;
    expect(mix?.dim).toBe("canal");
    expect(mix?.share).toBeGreaterThan(0.15);
    expect(mix?.share).toBeLessThan(0.3);
  });

  test("se repete: o computador ganha em quase todo canal com amostra", () => {
    // "outros" e "social" são os canais em que o celular vai melhor.
    expect(d?.consistency.canal).toEqual({ same: 5, total: 7 });
    expect(d?.consistency.visitante).toEqual({ same: 2, total: 2 });
  });

  test("cada recorte guarda as duas taxas e a fatia", () => {
    const social = d?.cuts.find((c) => c.key === "social_pago");
    expect(social?.share).toBeCloseTo(0.5, 1);
    expect(social?.rate).toBeCloseTo(0.0506, 3);
    expect(social?.comp_rate).toBeCloseTo(0.0835, 3);
  });

  test("a confiabilidade mostra a comparação justa e a repetição", () => {
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

describe("drilldown sem o que recortar", () => {
  test("etapa do Deco Analytics, sem comparação ou sem recortes: null", () => {
    const pdp = measureMetric(sample, { ...ref, key: "pdp_carrinho" });
    expect(drilldown(pdp, sample.segments)).toBeNull();
    const alone = measureMetric(sample, { ...ref, compare_to: null });
    expect(drilldown(alone, sample.segments)).toBeNull();
    expect(drilldown(measureMetric(sample, ref), [])).toBeNull();
  });
});

describe("mix que explica o gap", () => {
  test("o gap some quando o celular tem a mistura do computador: atenção", () => {
    // Cada canal converte igual nas duas telas; o celular só tem mais
    // tráfego do canal fraco.
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
  test("uma linha por canal, maior fatia do celular primeiro", () => {
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

describe("segmentPremise (outra loja, 15/11)", () => {
  // viu produto → carrinho por canal: mídia paga x o resto, nas duas telas.
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

  test("mídia paga converte 3% no celular contra 7% do resto", () => {
    const p = segmentPremise(m, cuts, { dim: "canal", key: "midia_paga" });
    expect(p?.rate).toBeCloseTo(0.03, 3);
    expect(p?.rest_rate).toBeCloseTo(0.0697, 3);
    expect(p?.comp_rate).toBeCloseTo(0.109, 3);
    expect(p?.comp_rest_rate).toBeCloseTo(0.168, 3);
  });

  test("segmento que não existe nos recortes não vale", () => {
    expect(parseSegmentRef({ dim: "canal", key: "tv" }, cuts)).toBeNull();
    expect(parseSegmentRef({ dim: "canal", key: "midia_paga" }, cuts)).toEqual({
      dim: "canal",
      key: "midia_paga",
    });
  });
});
