import { describe, expect, test } from "bun:test";
import { evidence as makeEvidence } from "../fixtures/evidence.ts";
import type { DevicePdpBehaviour, PageCapture } from "../types.ts";
import { knowledgeLine, knowledgeScore } from "./select.ts";
import type { KnowledgeEntry } from "./types.ts";
import { markStale, pageSignature } from "./validity.ts";

const capture = (over: Partial<PageCapture> = {}): PageCapture => ({
  device: "mobile",
  url: "https://loja/p",
  product_id: "1",
  viewport: { width: 390, height: 844 },
  page_height: 5000,
  fold_url: null,
  full_url: null,
  positions: { price: 699, size_selector: 1031, buy_button: 660 },
  has_sticky_buy: false,
  sold_out_signal: false,
  above_fold_outline: [],
  selectors: {},
  dom_excerpt: "",
  stock: "alive",
  ...over,
});
const behaviour = (sections: string[]): DevicePdpBehaviour => ({
  ...makeEvidence().pdp_behaviour[0]!,
  sections: sections.map((section) => ({
    section,
    reach_pct: 50,
    avg_seconds: 3,
    ctr_pct: 1,
    clicks: 10,
  })),
});

const today = makeEvidence({
  captures: [capture()],
  pdp_behaviour: [behaviour(["Product/ProductDetails", "Product/ShelfLook"])],
});

describe("assinatura da página", () => {
  test("é do template: outro produto (outras posições) dá a mesma", () => {
    const other = makeEvidence({
      captures: [
        capture({
          positions: { price: 720, size_selector: 1200, buy_button: 700 },
        }),
      ],
      pdp_behaviour: [
        behaviour(["Product/ShelfLook", "Product/ProductDetails"]),
      ],
    });
    expect(pageSignature(today, "mobile")).toBe(pageSignature(other, "mobile"));
    expect(pageSignature(today, "mobile")).toMatch(
      /^pdp\|mobile\|[0-9a-f]{8}$/,
    );
  });

  test("seção nova, parte que some ou barra fixa nova mudam a assinatura", () => {
    const base = pageSignature(today, "mobile");
    const newSection = makeEvidence({
      captures: [capture()],
      pdp_behaviour: [
        behaviour([
          "Product/ProductDetails",
          "Product/ShelfLook",
          "Product/Reviews",
        ]),
      ],
    });
    const sticky = makeEvidence({
      captures: [capture({ has_sticky_buy: true })],
      pdp_behaviour: [
        behaviour(["Product/ProductDetails", "Product/ShelfLook"]),
      ],
    });
    expect(pageSignature(newSection, "mobile")).not.toBe(base);
    expect(pageSignature(sticky, "mobile")).not.toBe(base);
  });

  test("sem captura nem seção não há o que assinar", () => {
    expect(
      pageSignature(
        makeEvidence({ captures: [], pdp_behaviour: [] }),
        "mobile",
      ),
    ).toBeNull();
  });
});

describe("veredito vencido", () => {
  const entry = (assinatura: string | null): KnowledgeEntry => ({
    id: "veredito:x",
    conhecimento: "Não é o caso nesta loja: o Leve o Look toma a 1ª tela",
    categoria: "ux",
    fonte: "Verificador",
    fonte_url: null,
    tipo_fonte: "veredito_desta_loja",
    contexto: "",
    areas: [],
    evidencia: "",
    confiabilidade: "alta",
    limitacoes: "",
    resultado: "refutada",
    origem: "veredito",
    diagnosis_id: "d",
    hypothesis_id: "h",
    assinatura,
    active: true,
    created_at: "2026-11-16T00:00:00Z",
    updated_at: "2026-11-16T00:00:00Z",
  });

  test("a página mudou: vence, perde peso e vai pro prompt como histórico", () => {
    const [stale, same, other, none] = markStale(
      [
        entry("pdp|mobile|deadbeef"),
        entry(pageSignature(today, "mobile")),
        entry("home|mobile|deadbeef"),
        entry(null),
      ],
      today,
    );
    expect(stale!.stale).toBe(true);
    expect(same!.stale).toBeUndefined();
    // Outra página (ou sem assinatura): não dá pra dizer, não mexe.
    expect(other!.stale).toBeUndefined();
    expect(none!.stale).toBeUndefined();
    const now = Date.parse("2026-11-19T00:00:00Z");
    expect(knowledgeScore(stale!, now)).toBeCloseTo(
      knowledgeScore(same!, now) * 0.3,
    );
    expect(knowledgeLine("K1", stale!)).toContain(
      "[K1] VENCIDO — a página mudou",
    );
  });
});
