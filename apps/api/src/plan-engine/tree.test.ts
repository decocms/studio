import { describe, expect, test } from "bun:test";
import { clampLabel } from "./claims.ts";
import { evidence as makeEvidence } from "./fixtures/evidence.ts";
import { parseDiscarded, parseTree, targetsOf } from "./tree.ts";

const evidence = makeEvidence({
  captures: [
    {
      device: "mobile",
      element_labels: { "root|1": { label: 'button "comprar"', y: 900 } },
    } as never,
  ],
});
const targets = targetsOf(evidence);

const base = {
  categoria: "ux",
  causa: "O tamanho fica abaixo da primeira tela",
  intervencao: "Barra fixa com tamanho e comprar",
  resultado: "Viu → carrinho no celular sobe",
  mecanismo: "A pessoa decide sem precisar rolar",
  metrica: { key: "produto_carrinho", direcao: "sobe", efeito_esperado_pp: 9 },
  alvo: { kind: "part", key: "size_selector" },
  posicao_depois: "primeira_tela",
  a_favor: [
    {
      texto: "seletor em y=1272 numa tela de 844",
      fatos: ["F3"],
      tipo: "fato_observado",
    },
  ],
  contra: [
    { texto: "quem rola chega ao seletor", tipo: "fato_observado" },
    { texto: "A/B provou", tipo: "conclusao_experimental" },
  ],
  como_refutar: "se quem vê o seletor na 1ª tela não vai mais ao carrinho",
};

describe("parseTree", () => {
  test("builds the If/then/because in code and checks target, effect and labels", () => {
    const t = parseTree(base, targets, 1);
    if (typeof t === "string") throw new Error(t);
    expect(t.statement).toBe(
      "Se barra fixa com tamanho e comprar, então viu → carrinho no celular sobe, porque a pessoa decide sem precisar rolar.",
    );
    expect(t.alvo).toEqual({
      kind: "part",
      key: "size_selector",
      label: "seletor de tamanho",
    });
    expect(t.metrica.efeito_esperado_pp).toBe(5);
    expect(t.posicao_depois).toBe("primeira_tela");
    // A "fact" without a number becomes an inference; an experiment never comes from the model
    expect(t.contra.map((c) => c.label)).toEqual(["inferencia", "inferencia"]);
    expect(t.a_favor[0]!.label).toBe("fato_observado");
    expect(t.testavel_na_pagina).toBe(true);
  });

  test("a target that does not exist in this analysis becomes null; a heatmap element is valid", () => {
    const bad = parseTree(
      { ...base, alvo: { kind: "part", key: "galeria" } },
      targets,
      1,
    );
    expect(typeof bad !== "string" && bad.alvo).toBeNull();
    const el = parseTree(
      { ...base, alvo: { kind: "element", key: "root|1" } },
      targets,
      1,
    );
    expect(typeof el !== "string" && el.alvo?.label).toBe('button "comprar"');
  });

  test("traffic may have no intervention (explanation outside the page); UX may not", () => {
    const traffic = parseTree(
      { ...base, categoria: "trafego", intervencao: null },
      targets,
      1,
    );
    expect(typeof traffic !== "string" && traffic.statement).toBeNull();
    expect(typeof traffic !== "string" && traffic.testavel_na_pagina).toBe(
      false,
    );
    expect(parseTree({ ...base, intervencao: null }, targets, 1)).toContain(
      "sem intervenção",
    );
    expect(parseTree({ ...base, mecanismo: "" }, targets, 1)).toContain(
      "sem mecanismo",
    );
  });

  test("unknown category becomes ux; a self relation is dropped", () => {
    const t = parseTree(
      {
        ...base,
        categoria: "magia",
        relacoes: [
          { rank: 1, tipo: "x" },
          { rank: 2, tipo: "causa_comum" },
        ],
      },
      targets,
      1,
    );
    if (typeof t === "string") throw new Error(t);
    expect(t.category).toBe("ux");
    expect(t.relacoes).toEqual([{ rank: 2, tipo: "causa_comum" }]);
  });
});

describe("clampLabel", () => {
  test("invalid label becomes inference", () => {
    expect(clampLabel("palpite", "x")).toBe("inferencia");
    expect(clampLabel("evidencia_indireta", "x")).toBe("evidencia_indireta");
  });
});

describe("parseDiscarded", () => {
  test("one line per valid category", () => {
    expect(
      parseDiscarded([
        { categoria: "performance", por_que: "LCP ok" },
        { categoria: "performance", por_que: "de novo" },
        { categoria: "nada", por_que: "x" },
      ]),
    ).toEqual([{ category: "performance", why: "LCP ok" }]);
  });
});

describe("lenient parseDiscarded", () => {
  test("'category: reason' text, with accent and uppercase", () => {
    expect(
      parseDiscarded([
        "Tráfego: o gap aparece em 5 de 7 canais",
        { category: "Confiança", motivo: "sem dado de avaliação" },
        "UX e interface — já coberta",
      ]),
    ).toEqual([
      { category: "trafego", why: "o gap aparece em 5 de 7 canais" },
      { category: "confianca", why: "sem dado de avaliação" },
      { category: "ux", why: "já coberta" },
    ]);
  });
});
