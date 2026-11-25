import { describe, expect, test } from "bun:test";
import * as scripts from "./page-scripts.ts";
import {
  type ActionNode,
  navigationOf,
  type TextTreeNode,
  visibleTextOf,
} from "./page-scripts.ts";
import { type ElementFacts, forbiddenReason } from "./verify/safety.ts";

/** Árvore mínima: string = nó de texto; [tag, ...filhos] = elemento. */
type Spec = string | [string, ...Spec[]];

function tree(spec: Spec): TextTreeNode {
  if (typeof spec === "string") {
    return {
      nodeType: 3,
      nodeValue: spec,
      firstChild: null,
      nextSibling: null,
    };
  }
  const [tag, ...kids] = spec;
  const nodes = kids.map(tree);
  nodes.forEach((n, i) => {
    n.nextSibling = nodes[i + 1] ?? null;
  });
  return {
    nodeType: 1,
    nodeValue: null,
    localName: tag,
    firstChild: nodes[0] ?? null,
    nextSibling: null,
  };
}

// O botão de compra de uma loja em 14/11: o JSON do evento vem dentro dele.
const BUY_BUTTON: Spec = [
  "button",
  [
    "script",
    '{"name":"add_to_cart","params":{"currency":"BRL","value":1299,"items":[{"item_id":"123"}]}}',
  ],
  ["span", "Adicionar à sacola"],
];

describe("visibleTextOf", () => {
  test("pula o JSON de <script> dentro do botão", () => {
    expect(visibleTextOf(tree(BUY_BUTTON))).toBe("Adicionar à sacola");
  });

  test("pula style, noscript e template, em qualquer profundidade", () => {
    const t = tree([
      "section",
      ["style", ".a{color:red}"],
      [
        "div",
        ["noscript", "ative o JS"],
        ["h2", "Complete ", ["b", "seu look"]],
      ],
      ["template", "<p>molde</p>"],
    ]);
    expect(visibleTextOf(t)).toBe("Complete seu look");
  });

  test("raiz que é script não tem texto visível", () => {
    expect(visibleTextOf(tree(["SCRIPT", "x"]))).toBe("");
  });

  test("junta espaços e quebras de linha", () => {
    expect(
      visibleTextOf(tree(["p", "  Frete\n\n", ["span", " grátis "]])),
    ).toBe("Frete grátis");
  });
});

describe("o texto limpo e a trava de clique", () => {
  const facts = (text: string): ElementFacts => ({
    found: true,
    tag: "button",
    text,
    role: null,
    type: "button",
    inLink: false,
    inButton: true,
    href: null,
    linkTarget: null,
    cursor: "pointer",
    color: "#ffffff",
    parentColor: "#000000",
    textDecoration: "none",
    hasClickHandler: false,
    inForm: false,
    inputType: null,
    rect: { x: 0, y: 923, width: 358, height: 48 },
  });

  test("botão só de ícone: o <title> do SVG não esconde o aria-label", () => {
    // <button aria-label="Adicionar à sacola"><svg><title>icon-bag</title></svg></button>
    const title = tree(["title", "icon-bag"]);
    const svg = { ...tree(["svg"]), firstChild: title };
    const attrs: Record<string, string> = {
      "aria-label": "Adicionar à sacola",
    };
    const button = {
      ...tree(["button"]),
      firstChild: svg,
      parentElement: null,
      onclick: null,
      getAttribute: (n: string) => attrs[n] ?? null,
      hasAttribute: (n: string) => n in attrs,
      closest: (sel: string) =>
        sel === "a[href]" || sel === "form" ? null : button,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 40, height: 40 }),
    };
    const g = globalThis as Record<string, unknown>;
    const saved = {
      document: g.document,
      window: g.window,
      getComputedStyle: g.getComputedStyle,
    };
    g.document = { querySelector: () => button };
    g.window = { scrollX: 0, scrollY: 0 };
    g.getComputedStyle = () => ({
      cursor: "pointer",
      color: "rgb(0, 0, 0)",
      textDecorationLine: "none",
    });
    try {
      const f = scripts.elementFactsInPage("button.icon");
      expect(f.text).toContain("icon-bag");
      expect(f.text).toContain("Adicionar à sacola");
      expect(forbiddenReason(f)).toBe("botão de compra");
    } finally {
      Object.assign(g, saved);
    }
  });

  test("o botão de compra continua proibido sem o JSON", () => {
    expect(forbiddenReason(facts(visibleTextOf(tree(BUY_BUTTON))))).toBe(
      "botão de compra",
    );
  });
});

/** Corpo de `const visibleText = (node) => {...}` no código serializado. */
function helperBody(source: string): string | null {
  const start = source.indexOf("visibleText = (node) => {");
  if (start < 0) return null;
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) {
      return source.slice(open, i + 1).replace(/\s+/g, "");
    }
  }
  return null;
}

describe("as funções da página usam o texto visível", () => {
  // As que leem texto de elementos. Cada uma declara a própria cópia do
  // helper (regra de serialização); a cópia tem que ser igual à testada.
  const readers = {
    measurePdpInPage: scripts.measurePdpInPage,
    measureSitePageInPage: scripts.measureSitePageInPage,
    extractDesignSystemInPage: scripts.extractDesignSystemInPage,
    elementLabelsInPage: scripts.elementLabelsInPage,
    elementFactsInPage: scripts.elementFactsInPage,
    chooseOptionInPage: scripts.chooseOptionInPage,
  };
  const pure = visibleTextOf.toString();
  const pureBody = pure.slice(pure.indexOf("{")).replace(/\s+/g, "");

  for (const [name, fn] of Object.entries(readers)) {
    test(`${name}: cópia do helper igual à testada`, () => {
      expect(helperBody(fn.toString())).toBe(pureBody);
    });
  }

  test("ninguém mais lê textContent (fora as exceções com motivo)", () => {
    // isProductPageInPage lê o JSON-LD de propósito; domExcerptInPage só lê
    // folha (sem filho, então sem <script> dentro); applyPatchInPage escreve.
    const allowed = new Set([
      "isProductPageInPage",
      "domExcerptInPage",
      "applyPatchInPage",
    ]);
    const offenders = Object.entries(scripts)
      .filter(([name, v]) => typeof v === "function" && !allowed.has(name))
      .filter(([, v]) => /\.textContent\b/.test(String(v)))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });
});

/** Corpo de uma função exportada, sem espaços. */
function fnBody(fn: (...args: never[]) => unknown): string {
  const src = fn.toString();
  return src.slice(src.indexOf("{")).replace(/\s+/g, "");
}

describe("quem rola a página: uma cópia só do critério", () => {
  // Cada função que rola ou mede posição no documento declara a própria
  // cópia de `pageScrollerInPage` (regra de serialização, 14/11).
  const users = {
    scrollPageToInPage: scripts.scrollPageToInPage,
    elementDocTopInPage: scripts.elementDocTopInPage,
    measurePdpInPage: scripts.measurePdpInPage,
    measureSitePageInPage: scripts.measureSitePageInPage,
    extractDesignSystemInPage: scripts.extractDesignSystemInPage,
    layoutOutlineInPage: scripts.layoutOutlineInPage,
    elementLabelsInPage: scripts.elementLabelsInPage,
    elementFactsInPage: scripts.elementFactsInPage,
  };
  const canonical = fnBody(scripts.pageScrollerInPage);
  for (const [name, fn] of Object.entries(users)) {
    test(`${name}: cópia igual a pageScrollerInPage`, () => {
      // O transpilador pode embutir a arrow usada uma vez só como IIFE;
      // o corpo, sem espaços, tem que estar lá do mesmo jeito.
      expect(fn.toString().replace(/\s+/g, "")).toContain(canonical);
    });
  }

  test("ninguém mais rola com window.scrollTo(0, y)", () => {
    const offenders = Object.entries(scripts)
      .filter(([, v]) => typeof v === "function")
      .filter(([, v]) => /window\.scrollTo\(\s*0\s*,/.test(String(v)))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });
});

/**
 * Página falsa: janela que só rola com `behavior: "instant"` (uma loja tem
 * scroll-behavior smooth) ou que nem rola (o <html> em overflow auto), e um
 * <body> que rola ou não.
 */
function fakeScrollPage(o: {
  windowScrolls: boolean;
  bodyScrolls: boolean;
  docHeight?: number;
}) {
  const g = globalThis as Record<string, unknown>;
  const saved = {
    window: g.window,
    document: g.document,
    getComputedStyle: g.getComputedStyle,
  };
  const docHeight = o.docHeight ?? 5556;
  const vh = 844;
  const clamp = (y: number) => Math.max(0, Math.min(y, docHeight - vh));
  const win = {
    innerWidth: 390,
    innerHeight: vh,
    scrollY: 0,
    scrollTo(arg: number | ScrollToOptions, y?: number) {
      // Com smooth, a rolagem só termina depois: logo após, ainda 0.
      if (typeof arg === "number" || arg.behavior !== "instant") return;
      if (o.windowScrolls) this.scrollY = clamp(arg.top ?? 0);
      void y;
    },
  };
  const body = {
    scrollTop: 0,
    scrollHeight: o.bodyScrolls ? docHeight : vh,
    clientHeight: vh,
    clientWidth: 390,
    querySelectorAll: () => [],
    contains: () => true,
    getBoundingClientRect: () => ({ top: 0, bottom: vh, left: 0, right: 390 }),
    scrollTo(arg: ScrollToOptions) {
      if (o.bodyScrolls) this.scrollTop = clamp(arg.top ?? 0);
    },
  };
  g.window = win;
  g.document = { body };
  g.getComputedStyle = () => ({
    overflowY: o.bodyScrolls ? "auto" : "visible",
    position: "relative",
    display: "block",
    visibility: "visible",
  });
  return {
    win,
    body,
    restore: () => Object.assign(g, saved),
  };
}

describe("scrollPageToInPage", () => {
  test("janela com scroll-behavior smooth: rola na hora (instant)", () => {
    const f = fakeScrollPage({ windowScrolls: true, bodyScrolls: false });
    try {
      expect(scripts.scrollPageToInPage(1000)).toBe(1000);
      expect(f.win.scrollY).toBe(1000);
    } finally {
      f.restore();
    }
  });

  test("loja de moda: a janela não mexe, quem rola é o body", () => {
    const f = fakeScrollPage({ windowScrolls: false, bodyScrolls: true });
    try {
      expect(scripts.scrollPageToInPage(1000)).toBe(1000);
      expect(f.body.scrollTop).toBe(1000);
      expect(scripts.scrollPageToInPage(0)).toBe(0);
      expect(f.body.scrollTop).toBe(0);
    } finally {
      f.restore();
    }
  });

  test("além do fim: devolve onde parou, não o pedido", () => {
    const f = fakeScrollPage({ windowScrolls: false, bodyScrolls: true });
    try {
      expect(scripts.scrollPageToInPage(9000)).toBe(5556 - 844);
    } finally {
      f.restore();
    }
  });
});

describe("productPriceValues", () => {
  const ld = (o: unknown) => JSON.stringify(o);

  test("JSON-LD Product com offers.price", () => {
    const r = scripts.productPriceValues(
      [ld({ "@type": "Product", offers: { "@type": "Offer", price: 244.3 } })],
      [],
      [],
    );
    expect(r).toEqual({ values: [244.3], list: [], from: "json-ld" });
  });

  test("AggregateOffer: lowPrice e a lista de dentro, sem repetir", () => {
    const r = scripts.productPriceValues(
      [
        ld({
          "@context": "https://schema.org",
          "@type": "Product",
          offers: {
            "@type": "AggregateOffer",
            lowPrice: 244.3,
            highPrice: 244.3,
            offers: [{ price: "244.30" }],
          },
        }),
      ],
      [],
      [],
    );
    expect(r.values).toEqual([244.3]);
  });

  test("offers em lista e preço de lista na priceSpecification", () => {
    const r = scripts.productPriceValues(
      [
        ld({
          "@type": "Product",
          offers: [
            {
              price: 699,
              priceSpecification: [
                { priceType: "https://schema.org/ListPrice", price: 899 },
              ],
            },
          ],
        }),
      ],
      [],
      [],
    );
    expect(r.values).toEqual([699]);
    expect(r.list).toEqual([899]);
  });

  test("@graph com breadcrumb antes; JSON quebrado não derruba", () => {
    const r = scripts.productPriceValues(
      [
        "{quebrado",
        ld({
          "@graph": [
            { "@type": "BreadcrumbList" },
            { "@type": "Product", offers: { price: "1.299,90" } },
          ],
        }),
      ],
      [],
      [],
    );
    expect(r).toEqual({ values: [1299.9], list: [], from: "json-ld" });
  });

  test("lista de outros produtos não é o preço desta peça", () => {
    const r = scripts.productPriceValues(
      [
        ld({
          "@type": "ItemList",
          itemListElement: [{ "@type": "Product", offers: { price: 99 } }],
        }),
      ],
      [],
      [],
    );
    expect(r.from).toBeNull();
  });

  test("sem JSON-LD: meta/itemprop", () => {
    expect(scripts.productPriceValues([], ["244.30"], [])).toEqual({
      values: [244.3],
      list: [],
      from: "meta",
    });
  });

  test("loja de moda (14/11): só o view_item do dataLayer tem o valor", () => {
    const layer = [
      { event: "gtm.js" },
      {
        event: "add_to_cart",
        ecommerce: { items: [{ price: 479 }] },
      },
      {
        event: "view_item",
        ecommerce: {
          currency: "BRL",
          value: 244.3,
          items: [
            { item_name: "Regata Estampada Verão Colorido", price: 244.3 },
          ],
        },
      },
    ];
    expect(scripts.productPriceValues([], [], layer)).toEqual({
      values: [244.3],
      list: [],
      from: "dataLayer",
    });
  });

  test('"1.998" é milhar, não 1,998 (revisão, 14/11)', () => {
    expect(scripts.productPriceValues([], ["1.998"], []).values).toEqual([
      1998,
    ]);
    expect(scripts.productPriceValues([], ["R$ 1.998,00"], []).values).toEqual([
      1998,
    ]);
    expect(scripts.productPriceValues([], ["1,998.50"], []).values).toEqual([
      1998.5,
    ]);
    expect(scripts.productPriceValues([], ["244.30"], []).values).toEqual([
      244.3,
    ]);
  });

  test("UA: ecommerce.detail.products", () => {
    const layer = [
      { ecommerce: { detail: { products: [{ price: "780.00" }] } } },
    ];
    expect(scripts.productPriceValues([], [], layer).values).toEqual([780]);
  });

  test("nada declarado: vazio", () => {
    expect(scripts.productPriceValues([], [], undefined)).toEqual({
      values: [],
      list: [],
      from: null,
    });
  });
});

describe("moneyHasValue", () => {
  test("o formato da página: 244.3 → 244,30", () => {
    expect(scripts.moneyHasValue("R$ 244,30", [244.3])).toBe(true);
    expect(scripts.moneyHasValue("R$ 349,00R$ 244,30", [244.3])).toBe(true);
    expect(scripts.moneyHasValue("$244.30", [244.3])).toBe(true);
  });

  test("milhar com ponto ou vírgula", () => {
    expect(scripts.moneyHasValue("R$ 1.299,90", [1299.9])).toBe(true);
    expect(scripts.moneyHasValue("$1,299.90", [1299.9])).toBe(true);
  });

  test("valor redondo sem centavos (outra loja: R$ 780)", () => {
    expect(scripts.moneyHasValue("R$ 780", [780])).toBe(true);
    expect(scripts.moneyHasValue("R$ 780,00", [780])).toBe(true);
  });

  test("não casa pedaço de outro número", () => {
    expect(scripts.moneyHasValue("R$ 1.244,30", [244.3])).toBe(false);
    expect(scripts.moneyHasValue("10x de R$ 24,43", [244.3])).toBe(false);
    expect(scripts.moneyHasValue("R$ 780,50", [780])).toBe(false);
    expect(scripts.moneyHasValue("R$ 335,30", [244.3])).toBe(false);
  });
});

describe("pickTopCandidate", () => {
  test("o mais alto vence o maior (loja de moda: o da foto, não o da folha)", () => {
    expect(
      scripts.pickTopCandidate(
        [
          { y: 1304, area: 342 * 56, pinned: false },
          { y: 660, area: 101 * 48, pinned: false },
        ],
        "large",
      ),
    ).toBe(1);
  });

  test("barra fixa não conta", () => {
    expect(
      scripts.pickTopCandidate(
        [
          { y: 790, area: 390 * 54, pinned: true },
          { y: 923, area: 350 * 48, pinned: false },
        ],
        "large",
      ),
    ).toBe(1);
    expect(
      scripts.pickTopCandidate([{ y: 790, area: 1, pinned: true }], "large"),
    ).toBe(-1);
  });

  test("empate de altura: o menor pro preço, o maior pro botão", () => {
    const tie = [
      { y: 699, area: 200 * 20, pinned: false },
      { y: 700, area: 80 * 20, pinned: false },
    ];
    expect(scripts.pickTopCandidate(tie, "small")).toBe(1);
    expect(scripts.pickTopCandidate(tie, "large")).toBe(0);
  });
});

describe("measurePdpInPage: cópias dos helpers de preço e botão", () => {
  const src = scripts.measurePdpInPage.toString().replace(/\s+/g, "");
  for (const fn of [
    scripts.productPriceValues,
    scripts.moneyHasValue,
    scripts.pickTopCandidate,
  ]) {
    test(`${fn.name}: cópia igual`, () => {
      expect(src).toContain(fnBody(fn as (...a: never[]) => unknown));
    });
  }
});

describe("revisão do ciclo 6 (14/11)", () => {
  test("labelTextOf: tooltip escondido fora do rótulo do tamanho", () => {
    const t = tree([
      "ul",
      ["li", "PP"],
      ["li", "P"],
      ["div", "vendido por parceiro. não elegível a promoções."],
    ]);
    const hidden = (n: TextTreeNode) => n.localName === "div";
    expect(scripts.labelTextOf(t, hidden)).toBe("PPP");
    // A trava de clique segue lendo tudo.
    expect(visibleTextOf(t)).toContain("vendido por parceiro");
  });

  test("labelText: as cópias são iguais à testada", () => {
    const canonical = fnBody(scripts.labelTextOf);
    for (const fn of [
      scripts.measurePdpInPage,
      scripts.elementLabelsInPage,
      scripts.elementFactsInPage,
    ]) {
      expect(fn.toString().replace(/\s+/g, "")).toContain(canonical);
    }
  });

  test("isBuyText: favorito e lista de desejos não são compra", () => {
    expect(scripts.isBuyText("comprar")).toBe(true);
    expect(scripts.isBuyText("Adicionar à Sacola")).toBe(true);
    expect(scripts.isBuyText("Adicionar aos favoritos")).toBe(false);
    expect(scripts.isBuyText("Adicionar à lista de desejos")).toBe(false);
    expect(scripts.isBuyText("Add to wishlist")).toBe(false);
    expect(scripts.isBuyText("x".repeat(30) + " comprar agora")).toBe(false);
  });

  test("priceMatches: o de venda ganha do riscado, o de lista só sem venda", () => {
    const has = scripts.moneyHasValue;
    const cands = [
      { text: "R$ 349,00", struck: true },
      { text: "R$ 244,30", struck: false },
    ];
    expect(scripts.priceMatches(cands, [244.3], [349], has)).toEqual([1]);
    // O valor de venda riscado (promo que a loja risca errado) não conta.
    expect(
      scripts.priceMatches(
        [{ text: "R$ 244,30", struck: true }],
        [244.3],
        [],
        has,
      ),
    ).toEqual([]);
    // Sem o de venda na página: o de lista, mesmo riscado.
    expect(scripts.priceMatches([cands[0]!], [244.3], [349], has)).toEqual([0]);
  });

  test("measurePdpInPage: cópias de isBuyText e priceMatches", () => {
    const src = scripts.measurePdpInPage.toString().replace(/\s+/g, "");
    expect(src).toContain(fnBody(scripts.isBuyText));
    expect(src).toContain(fnBody(scripts.priceMatches));
  });

  test("rolador: gaveta fora da tela não é a página", () => {
    const g = globalThis as Record<string, unknown>;
    const saved = {
      window: g.window,
      document: g.document,
      getComputedStyle: g.getComputedStyle,
    };
    const box = (top: number) => ({
      scrollHeight: 2000,
      clientHeight: 800,
      clientWidth: 390,
      getBoundingClientRect: () => ({
        top,
        bottom: top + 800,
        left: 0,
        right: 390,
      }),
    });
    const drawer = box(900);
    const main = box(0);
    g.window = { innerWidth: 390, innerHeight: 844 };
    g.document = {
      body: {
        ...box(0),
        scrollHeight: 844,
        clientHeight: 844,
        querySelectorAll: () => [drawer, main],
      },
    };
    g.getComputedStyle = () => ({
      overflowY: "auto",
      position: "relative",
      display: "block",
      visibility: "visible",
    });
    try {
      expect(scripts.pageScrollerInPage()).toBe(main as unknown as Element);
      g.document = {
        body: {
          ...box(0),
          scrollHeight: 844,
          clientHeight: 844,
          querySelectorAll: () => [drawer],
        },
      };
      expect(scripts.pageScrollerInPage()).toBeNull();
    } finally {
      Object.assign(g, saved);
    }
  });
});

describe("navigationOf: pra onde o clique leva", () => {
  /** Árvore mínima: cada nó sabe o pai, a tag e os atributos. */
  type Fake = {
    localName: string;
    attrs: Record<string, string>;
    parent: Fake | null;
  };
  const node = (
    localName: string,
    attrs: Record<string, string> = {},
    parent: Fake | null = null,
  ): Fake => ({ localName, attrs, parent });
  const matches = (n: Fake, sel: string): boolean =>
    sel.split(",").some((one) => {
      const s = one.trim();
      const m = s.match(/^(\w+)(?:\[(\w+)(?:='([^']*)')?\])?$/);
      if (!m) return false;
      const [, tag, attr, value] = m;
      if (n.localName !== tag) return false;
      if (!attr) return true;
      if (!(attr in n.attrs)) return false;
      return value === undefined || n.attrs[attr] === value;
    });
  const wrap = (n: Fake): ActionNode => ({
    localName: n.localName,
    getAttribute: (name) => n.attrs[name] ?? null,
    closest: (sel) => {
      for (let c: Fake | null = n; c; c = c.parent) {
        if (matches(c, sel)) return wrap(c);
      }
      return null;
    },
  });
  const here = "https://www.loja.example/";

  test("envio da busca da loja leva pra /buscar", () => {
    const form = node("form", { action: "/buscar" });
    const submit = node("button", { type: "submit" }, form);
    const svg = node("svg", {}, submit);
    expect(navigationOf(wrap(submit), here)).toBe("/buscar");
    // Clique no ícone dentro do botão ancora no ícone.
    expect(navigationOf(wrap(svg), here)).toBe("/buscar");
  });

  test("botão sem type dentro de form envia; type=button não", () => {
    const form = node("form", {});
    expect(navigationOf(wrap(node("button", {}, form)), here)).toBe("/");
    expect(
      navigationOf(wrap(node("button", { type: "button" }, form)), here),
    ).toBe("");
  });

  test("botão fora de form e label não trocam de página", () => {
    expect(navigationOf(wrap(node("button", { type: "submit" })), here)).toBe(
      "",
    );
    expect(navigationOf(wrap(node("label", { for: "x" })), here)).toBe("");
  });

  test("link: caminho; âncora e javascript não contam; outro site leva o host", () => {
    const a = (href: string) => wrap(node("img", {}, node("a", { href })));
    expect(navigationOf(a("/colecao/vestidos?x=1"), here)).toBe(
      "/colecao/vestidos",
    );
    expect(navigationOf(a("#topo"), here)).toBe("");
    expect(navigationOf(a("javascript:void(0)"), here)).toBe("");
    expect(navigationOf(a("https://wa.me/55"), here)).toBe("wa.me/55");
  });

  test("cópia dentro de elementLabelsInPage igual à testada", () => {
    const canonical = fnBody(navigationOf);
    expect(
      scripts.elementLabelsInPage.toString().replace(/\s+/g, ""),
    ).toContain(canonical);
  });
});
