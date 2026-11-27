import { describe, expect, test } from "bun:test";
import { factIndex, type UxFact } from "./facts.ts";
import type { HypothesisTree, UxClaim } from "./tree.ts";
import { crossRunKey, reactedProbe, triage, triageKey } from "./triage.ts";

const fact = (
  id: string,
  kind: UxFact["kind"],
  device: UxFact["device"],
  text: string,
): UxFact => ({
  id,
  kind,
  source: kind === "funil" ? "ga4" : "pagina",
  device,
  measured: true,
  group: "g",
  text,
});

// A fashion store's PDP, reduced.
const book = factIndex([
  fact("F1", "funil", "mobile", "add_to_cart: 9.9% de view_item"),
  fact("F2", "funil", "desktop", "add_to_cart: 25.8% de view_item"),
  fact(
    "F3",
    "posicao",
    "mobile",
    "seletor de tamanho: y=1031px, abaixo da 1ª tela",
  ),
  fact("F4", "posicao", "desktop", "seletor de tamanho: y=258px, na 1ª tela"),
  fact("F5", "pagina", "mobile", "barra de compra fixa ao rolar: não"),
  fact("F6", "pagina", "desktop", "barra de compra fixa ao rolar: não"),
  fact(
    "F7",
    "interacao",
    "mobile",
    'tocar em button "Next item" (y=40px): observe_click: abriu diálogo (0 → 1)',
  ),
]);

const claim = (facts: string[]): UxClaim => ({
  text: "x",
  label: "fato_observado",
  facts,
});
const tree = (over: Partial<HypothesisTree> = {}): HypothesisTree => ({
  category: "ux",
  statement: null,
  intervencao: "faz",
  resultado: "sobe",
  mecanismo: "porque",
  causa: "o tamanho fica abaixo da 1ª tela no celular",
  a_favor: [claim(["F3"])],
  contra: [],
  fontes_conhecimento: [],
  segmento: "",
  metrica: { key: null, direcao: "sobe", efeito_esperado_pp: null },
  como_verificar: "",
  como_refutar: "",
  alvo: { kind: "part", key: "size_selector", label: "seletor de tamanho" },
  posicao_depois: "primeira_tela",
  relacoes: [],
  esforco: 2,
  testavel_na_pagina: true,
  ...over,
});
const input = (t: HypothesisTree, over: Record<string, unknown> = {}) => ({
  title: t.causa,
  tree: t,
  control: "dispositivo",
  elementLabel: null,
  ...over,
});

describe("triage", () => {
  test("the size hypothesis, with a page fact and a real contrast, passes", () => {
    expect(
      triage(input(tree({ fatos_contraste: ["F3", "F4"] })), book),
    ).toBeNull();
  });

  test("without a supporting fact it is dropped", () => {
    expect(triage(input(tree({ a_favor: [claim([])] })), book)).toContain(
      "nenhum fato a favor",
    );
  });

  test("a funnel number alone is a symptom; traffic can be one", () => {
    const t = tree({ a_favor: [claim(["F1", "F2"])] });
    expect(triage(input(t), book)).toContain("sintoma");
    expect(triage(input({ ...t, category: "trafego" }), book)).toBeNull();
  });

  test("without a page fact in the book (checkout), the funnel is enough", () => {
    const funnelOnly = factIndex(
      [...book.values()].filter((f) => f.kind === "funil"),
    );
    expect(
      triage(input(tree({ a_favor: [claim(["F1"])] })), funnelOnly),
    ).toBeNull();
  });

  test("a contrast that is the same on both screens is dropped", () => {
    expect(
      triage(
        input(
          tree({ a_favor: [claim(["F5"])], fatos_contraste: ["F5", "F6"] }),
        ),
        book,
      ),
    ).toContain("igual nas duas telas (barra de compra fixa ao rolar: não)");
  });

  test("same category, target and facts as one already accepted: repeated", () => {
    const t = tree();
    const key = triageKey(t);
    expect(key).toBe("ux|part:size_selector|F3");
    expect(triage(input(t), book, key ? [key] : [])).toContain("repete");
  });

  test("'does not respond' is dropped when the probe touched and the page reacted", () => {
    const t = tree({
      causa: "as setas da galeria não respondem ao toque",
      a_favor: [claim(["F7"])],
      alvo: { kind: "element", key: "P|1", label: 'button "Next item"' },
    });
    const out = triage(
      input(t, { control: "absoluta", elementLabel: 'button "Next item"' }),
      book,
    );
    expect(out).toContain("a sonda tocou no elemento e a página reagiu (F7");
    expect(reactedProbe('button "Zoom"', book)).toBeNull();
  });
});

describe("a cause an earlier round refuted on this page", () => {
  const sized = tree({
    fatos_contraste: ["F3", "F4"],
    metrica: {
      key: "produto_carrinho",
      direcao: "sobe",
      efeito_esperado_pp: 1,
    },
  });
  const refuted = new Map([
    [crossRunKey(sized) ?? "", { title: "O tamanho fica escondido" }],
  ]);

  test("the same target and step is dropped, whatever the wording", () => {
    expect(
      triage(
        input({ ...sized, causa: "o seletor some abaixo da dobra" }),
        book,
        [],
        refuted,
      ),
    ).toContain(
      'uma rodada anterior já desmentiu essa causa nesta página ("O tamanho fica escondido")',
    );
  });

  test("another step on the same target is a different cause", () => {
    const other = {
      ...sized,
      metrica: { ...sized.metrica, key: "pagina_produto" as const },
    };
    expect(triage(input(other), book, [], refuted)).toBeNull();
  });

  test("the key ignores fact ids, which change every round", () => {
    expect(crossRunKey({ ...sized, a_favor: [claim(["F9"])] })).toBe(
      crossRunKey(sized),
    );
    expect(crossRunKey(tree({ alvo: null }))).toBeNull();
  });
});
