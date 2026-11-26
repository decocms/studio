import { describe, expect, test } from "bun:test";
import { groundedLabel } from "./claims.ts";
import {
  buildFacts,
  checkGrounding,
  factBook,
  factBookForPrompt,
  factIndex,
  isSupported,
  numbersIn,
  parseFactIds,
} from "./facts.ts";
import { evidence as makeEvidence } from "./fixtures/evidence.ts";
import { parseClaims } from "./tree.ts";
import type { DiagnosisEvidence, PageCapture } from "./types.ts";

/** PDP part positions, mobile and desktop. */
const capture = (
  device: "mobile" | "desktop",
  height: number,
  positions: PageCapture["positions"],
): PageCapture => ({
  device,
  url: "https://loja/p",
  product_id: "1",
  viewport: { width: device === "mobile" ? 390 : 1440, height },
  page_height: 5000,
  fold_url: null,
  full_url: null,
  positions,
  has_sticky_buy: false,
  sold_out_signal: false,
  above_fold_outline: ["galeria", "nome", "preço"],
  selectors: {},
  dom_excerpt: "",
  stock: "alive",
});

const ev: DiagnosisEvidence = makeEvidence({
  captures: [
    capture("mobile", 844, {
      price: 699,
      size_selector: 1031,
      buy_button: 660,
      shipping: 1484,
    }),
    capture("desktop", 900, {
      price: 187,
      size_selector: 258,
      buy_button: 491,
      shipping: 679,
    }),
  ],
});
const facts = buildFacts(ev);
const book = factIndex(facts);
const idOf = (pattern: RegExp, device?: "mobile" | "desktop") => {
  const f = facts.find(
    (x) => pattern.test(x.text) && (!device || x.device === device),
  );
  if (!f) throw new Error(`sem fato ${pattern}`);
  return f.id;
};

describe("buildFacts", () => {
  test("stable ids: the same evidence gives the same ledger", () => {
    expect(buildFacts(ev)).toEqual(facts);
    expect(facts.map((f) => f.id)).toEqual(facts.map((_, i) => `F${i + 1}`));
  });

  test("the position says whether it is on the first screen and how much scrolling is left", () => {
    const size = book.get(idOf(/seletor de tamanho/, "mobile"));
    expect(size?.text).toBe(
      "seletor de tamanho: y=1031px, abaixo da 1ª tela (844px): 187px de rolagem",
    );
    expect(size?.measured).toBe(true);
    expect(size?.source).toBe("pagina");
    expect(book.get(idOf(/seletor de tamanho/, "desktop"))?.text).toBe(
      "seletor de tamanho: y=258px, na 1ª tela (que vai até 900px)",
    );
  });

  test("the GA4 funnel becomes one fact per step, with the device", () => {
    const cart = facts.filter((f) => /^add_to_cart/.test(f.text));
    expect(cart.map((f) => [f.device, f.text])).toEqual([
      ["mobile", "add_to_cart: 5000 (10.0% de view_item)"],
      ["desktop", "add_to_cart: 2000 (20.0% de view_item)"],
    ]);
  });

  test("a competitor is an AI reading, not a measured fact", () => {
    const withBench = buildFacts({
      ...ev,
      benchmark: [
        {
          domain: "concorrente.example",
          url: "https://concorrente.example/p",
          screenshot_url: null,
          full_url: null,
          anatomy: {
            sticky_buy: true,
            size_above_fold: null,
            price_above_fold: true,
            shipping_estimate: false,
            wishlist: true,
            recommendation_position: null,
            notes: "",
            by_area: { tamanho: "grade em pílulas" },
          },
          captured_at: "2026-11-16T00:00:00Z",
        },
      ],
    });
    const bench = withBench.filter((f) => f.kind === "concorrente");
    expect(bench).toHaveLength(2);
    expect(bench.every((f) => !f.measured)).toBe(true);
    expect(bench[1]!.text).toBe(
      "concorrente.example, tamanho: grade em pílulas",
    );
  });

  test("the ledger stored in the evidence wins over rebuilding", () => {
    const stored = [{ ...facts[0]!, text: "gravado" }];
    expect(factBook({ ...ev, facts: stored })[0]!.text).toBe("gravado");
    expect(factBook(ev)).toEqual(facts);
  });

  test("the prompt puts the id first and the missing sources last", () => {
    const text = factBookForPrompt(facts, [
      { source: "heatmap", error: "fora do ar" },
    ]);
    expect(text).toContain(
      `- ${idOf(/seletor de tamanho/, "mobile")}: seletor`,
    );
    expect(text).toContain("## Página real — mobile (390×844)");
    expect(text.trim().endsWith("- heatmap: fora do ar")).toBe(true);
  });

  test("old evidence, without viewport or positions, does not break", () => {
    const old = {
      ...ev,
      captures: [{ device: "mobile" } as unknown as PageCapture],
      pdp_behaviour: [],
    };
    expect(() => buildFacts(old)).not.toThrow();
  });
});

describe("numbersIn", () => {
  const values = (t: string) => numbersIn(t).map((n) => n.value * n.scale);

  test("comma or dot decimal; a dot with 3 digits is thousands", () => {
    expect(values("9,9% contra 25.8%")).toEqual([9.9, 25.8]);
    expect(values("104.604 cliques em 1.031px")).toEqual([104_604, 1031]);
    expect(values("cerca de 72,5 mil usuárias e R$ 2,26 mi")).toEqual([
      72_500, 2_260_000,
    ]);
  });

  test("ids, ordinals and small unitless integers are not measures", () => {
    expect(values("[F12] e L3 na 1ª tela, p25, 2 cards, 3 tamanhos")).toEqual(
      [],
    );
    // With a unit, even a small number is a measure.
    expect(values("5% e 3px e 2pp")).toEqual([5, 3, 2]);
  });
});

describe("isSupported", () => {
  const n = (t: string) => numbersIn(t)[0]!;
  test("the same number, rounded as written", () => {
    expect(isSupported(n("25,8%"), [25.79])).toBe(true);
    expect(isSupported(n("26%"), [25.79])).toBe(true);
    expect(isSupported(n("25,9%"), [25.79])).toBe(false);
  });

  test("difference, sum and ratio of two cited numbers", () => {
    expect(isSupported(n("15,9pp"), [25.8, 9.9])).toBe(true);
    expect(isSupported(n("2,6x"), [25.8, 9.9])).toBe(true);
    // 56,8% = 1.022.400 out of 1.800.000.
    expect(isSupported(n("56,8%"), [1_022_400, 1_800_000])).toBe(true);
    expect(isSupported(n("439px"), [1031, 844])).toBe(false);
  });
});

describe("checkGrounding", () => {
  const size = idOf(/seletor de tamanho/, "mobile");
  const buy = idOf(/botão de compra/, "mobile");

  test("the real PDP observation is in the facts it cites", () => {
    const g = checkGrounding(
      "No celular o botão 'comprar' está na 1ª tela (660px), mas o seletor de tamanho fica a 1031px, 187px abaixo da 1ª tela.",
      [size, buy],
      book,
    );
    expect(g.unknown).toEqual([]);
    expect(g.unsupported).toEqual([]);
    expect(g.facts.map((f) => f.id)).toEqual([size, buy]);
  });

  test("a nonexistent id and a number not in the fact are reported", () => {
    const g = checkGrounding(
      "o tamanho fica a 1031px e o banner tem 439px",
      [size, "F999"],
      book,
    );
    expect(g.unknown).toEqual(["F999"]);
    expect(g.unsupported).toEqual(["439px"]);
  });
});

describe("parseFactIds", () => {
  test("accepts list, text and brackets, without repeats", () => {
    expect(parseFactIds(["F12", "f3", "[F12]"])).toEqual(["F12", "F3"]);
    expect(parseFactIds("F1, F2")).toEqual(["F1", "F2"]);
    expect(parseFactIds(null)).toEqual([]);
  });
});

describe("the 'fato' label is assigned by code", () => {
  const size = idOf(/seletor de tamanho/, "mobile");

  test("cited measured fact and verified number: stays a fact", () => {
    const [c] = parseClaims(
      [{ texto: "tamanho em y=1031px", fatos: [size], tipo: "fato_observado" }],
      book,
    );
    expect(c).toEqual({
      text: "tamanho em y=1031px",
      label: "fato_observado",
      facts: [size],
    });
  });

  test("no fact, an outside number or an invented id: becomes an inference", () => {
    const claims = parseClaims(
      [
        { texto: "tamanho em y=1031px", tipo: "fato_observado" },
        { texto: "tamanho em y=900px", fatos: [size], tipo: "fato_observado" },
        {
          texto: "tamanho em y=1031px",
          fatos: [size, "F999"],
          tipo: "fato_observado",
        },
      ],
      book,
    );
    expect(claims.map((c) => c.label)).toEqual([
      "inferencia",
      "inferencia",
      "inferencia",
    ]);
  });

  test("screenshot reading alone (competitor) is at most indirect", () => {
    const bench = {
      id: "F1",
      kind: "concorrente" as const,
      source: "benchmark" as const,
      device: "mobile" as const,
      measured: false,
      group: "g",
      text: "concorrente.example: barra fixa sim",
    };
    expect(
      groundedLabel("fato_observado", {
        facts: [bench],
        unknown: [],
        unsupported: [],
      }),
    ).toBe("evidencia_indireta");
    // The model never gives an experiment conclusion.
    expect(
      groundedLabel("conclusao_experimental", {
        facts: [bench],
        unknown: [],
        unsupported: [],
      }),
    ).toBe("inferencia");
  });
});

describe("the cited data, for the reader", () => {
  test("source, screen and sentence; AI reading marked; no id", async () => {
    const { factLine } = await import("./facts.ts");
    const size = facts.find(
      (f) => f.device === "mobile" && f.text.startsWith("seletor de tamanho"),
    );
    if (!size) throw new Error("sem fato");
    expect(factLine(size)).toBe(
      "página real, celular: seletor de tamanho: y=1031px, abaixo da 1ª tela (844px): 187px de rolagem",
    );
    expect(
      factLine({
        ...size,
        kind: "concorrente",
        source: "benchmark",
        measured: false,
        text: "concorrente.example: barra fixa sim",
      }),
    ).toBe(
      "concorrente, celular: concorrente.example: barra fixa sim (lido por IA)",
    );
  });

  test("the hypothesis evidence carries the data under the claim", async () => {
    const { claimsMarkdown } = await import("./tree.ts");
    const size = facts.find(
      (f) => f.device === "mobile" && f.text.startsWith("seletor de tamanho"),
    );
    if (!size) throw new Error("sem fato");
    const md = claimsMarkdown(
      {
        a_favor: [
          {
            text: "o tamanho cai abaixo da 1ª tela",
            label: "fato_observado",
            facts: [size.id],
          },
        ],
        contra: [],
      } as never,
      book,
    );
    expect(md).toBe(
      "**A favor:**\n- o tamanho cai abaixo da 1ª tela (fato)\n  - página real, celular: seletor de tamanho: y=1031px, abaixo da 1ª tela (844px): 187px de rolagem",
    );
  });
});
