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
  test("amostra grande e diferença fora do ruído: alta, só o aviso da janela", () => {
    const r = assess(evidence());
    expect(r.level).toBe("alta");
    expect(codes(r)).toEqual(["amostra:ok", "ruido:ok", "janela:info"]);
  });

  test("diferença dentro do ruído bloqueia", () => {
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

  // 16/11 (categoria de uma loja de moda): "o celular perde" com o celular em 37,8% e o
  // computador em 23,2% saiu "média" e valia R$ 387 mil/mês.
  test("o dispositivo que a oportunidade diz perder está MELHOR: bloqueia", () => {
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

  test("fora da PDP, GA4 'vendo produto' x visitantes da página não é contradição", () => {
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

  test("amostra mínima bloqueia; pequena pede atenção", () => {
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

  test("sem métrica, ou métrica que não existe nos dados: atenção", () => {
    expect(codes(assess(evidence(), null))).toContain("metrica:atencao");
    const missing = assess(evidence({ platform_funnel: [] }), {
      key: "checkout_compra",
      device: "mobile",
      compare_to: null,
    });
    expect(missing.level).toBe("media");
  });

  test("fonte citada que falhou pede atenção; a que não é citada não", () => {
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

  test("tracking: mais carrinho que produto visto, e GA4 x Deco Analytics de tamanhos muito diferentes", () => {
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

describe("premissa do segmento", () => {
  const base = {
    dim: "canal" as const,
    key: "midia_paga",
    device: "mobile" as const,
    n: 160_653,
    rest_n: 72_556,
    comp_device: "desktop" as const,
  };

  test("outra loja: mídia paga pior que o resto, e a diferença de tela é maior nela", () => {
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

  test("segmento que não converte menos bloqueia", () => {
    const out = premiseChecks({
      ...base,
      rate: 0.08,
      rest_rate: 0.07,
      comp_rate: 0.1,
      comp_rest_rate: 0.1,
    });
    expect(out[0]!.severity).toBe("bloqueia");
  });

  test("o celular perde igual fora do segmento: a diferença de tela não é dele", () => {
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
