import { describe, expect, test } from "bun:test";
import { evidence, sampleFunnel, sampleSegments } from "./fixtures/evidence.ts";
import { categoriaPromo } from "./fixtures/categoria-promo.ts";
import { controlNote, findLosses } from "./losses.ts";
import { metricMeasuresPage } from "./metrics.ts";

describe("findLosses", () => {
  test("categoria de uma loja de moda: só o funil da própria rota, nunca a vitrine do site inteiro", () => {
    const losses = findLosses(categoriaPromo);
    expect(losses.length).toBeGreaterThan(0);
    for (const l of losses) {
      expect(metricMeasuresPage(l.key, "categoria")).toBe(true);
      expect(l.key).not.toBe("lista_produto");
      expect(l.title).toContain("/colecao/promo");
    }
    expect(losses.map((l) => l.title)).toContain(
      "No celular, 49,4% de quem entra em /colecao/promo abre um produto; no computador, 51,3%",
    );
  });

  test("toda perda de dispositivo tem o dispositivo dela pior, fora do ruído", () => {
    for (const ev of [
      categoriaPromo,
      { ...categoriaPromo, page_type: "pdp" as const, page_route: null },
      { ...categoriaPromo, page_type: "carrinho_checkout" as const },
    ]) {
      for (const l of findLosses(ev).filter(
        (x) => x.control === "dispositivo",
      )) {
        expect(l.measured.gap_pp ?? 0).toBeGreaterThan(0);
        expect(l.measured.comp?.rate ?? 0).toBeGreaterThan(l.measured.rate);
      }
    }
  });

  test("celular melhor que o computador: a perda de dispositivo é do computador", () => {
    const ev = evidence({
      platform_funnel: [
        {
          platform: "web_mobile",
          steps: [
            { event: "view_item", count: 50_000 },
            { event: "add_to_cart", count: 15_000 },
          ],
        },
        {
          platform: "web_desktop",
          steps: [
            { event: "view_item", count: 10_000 },
            { event: "add_to_cart", count: 1_000 },
          ],
        },
      ],
    });
    const device = findLosses(ev).filter((l) => l.control === "dispositivo");
    expect(device.map((l) => [l.device, l.compare_to])).toEqual([
      ["desktop", "mobile"],
    ]);
  });

  test("diferença no ruído não é perda de dispositivo", () => {
    const ev = evidence({
      platform_funnel: [
        {
          platform: "web_mobile",
          steps: [
            { event: "view_item", count: 1_000 },
            { event: "add_to_cart", count: 100 },
          ],
        },
        {
          platform: "web_desktop",
          steps: [
            { event: "view_item", count: 1_000 },
            { event: "add_to_cart", count: 110 },
          ],
        },
      ],
    });
    expect(findLosses(ev).some((l) => l.control === "dispositivo")).toBe(false);
  });

  test("segmento só com distância de verdade, e nunca 'outros' ou 'sem dado'", () => {
    const losses = findLosses(
      evidence({ platform_funnel: sampleFunnel, segments: sampleSegments }),
    );
    const seg = losses.filter((l) => l.control === "segmento");
    expect(seg.length).toBeGreaterThan(0);
    for (const l of seg) {
      expect(l.segment?.key).not.toBe("outros");
      expect(l.segment?.key).not.toBe("sem_dado");
      expect(l.premise?.rate ?? 1).toBeLessThanOrEqual(
        (l.premise?.rest_rate ?? 0) * 0.85,
      );
    }
    // Social pago no celular: 5,1% x o resto — a perda que a loja conhece.
    expect(
      seg.some(
        (l) => l.segment?.key === "social_pago" && l.device === "mobile",
      ),
    ).toBe(true);
  });

  test("amostra pequena não vira perda; sem funil da página, nenhuma perda", () => {
    const tiny = evidence({
      page_type: "busca",
      pdp_behaviour: [
        {
          ...evidence().pdp_behaviour[0]!,
          funnel: { visitors: 100, viewed: 10, carted: 1 },
        },
      ],
    });
    expect(findLosses(tiny)).toEqual([]);
  });

  test("ids estáveis e a frase de cada tipo de perda", () => {
    const losses = findLosses(categoriaPromo);
    expect(losses.map((l) => l.id)).toEqual(losses.map((_, i) => `L${i + 1}`));
    expect(controlNote("absoluta")).toContain("NÃO derruba");
    expect(controlNote("dispositivo")).toContain("muda entre as telas");
  });
});
