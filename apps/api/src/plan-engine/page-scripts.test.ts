import { describe, expect, test } from "bun:test";
import * as scripts from "./page-scripts.ts";
import {
  type ActionNode,
  navigationOf,
  type TextTreeNode,
  visibleTextOf,
} from "./page-scripts.ts";
import { type ElementFacts, forbiddenReason } from "./verify/safety.ts";

/** Minimal tree: string = text node; [tag, ...children] = element. */
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

// A store's buy button: the event JSON sits inside it.
const BUY_BUTTON: Spec = [
  "button",
  [
    "script",
    '{"name":"add_to_cart","params":{"currency":"BRL","value":1299,"items":[{"item_id":"123"}]}}',
  ],
  ["span", "Adicionar à sacola"],
];

describe("visibleTextOf", () => {
  test("skips the <script> JSON inside the button", () => {
    expect(visibleTextOf(tree(BUY_BUTTON))).toBe("Adicionar à sacola");
  });

  test("skips style, noscript and template at any depth", () => {
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

  test("a script root has no visible text", () => {
    expect(visibleTextOf(tree(["SCRIPT", "x"]))).toBe("");
  });

  test("collapses spaces and line breaks", () => {
    expect(
      visibleTextOf(tree(["p", "  Frete\n\n", ["span", " grátis "]])),
    ).toBe("Frete grátis");
  });
});

describe("the clean text and the click lock", () => {
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

  test("icon-only button: the SVG <title> does not hide the aria-label", () => {
    // <button aria-label="..."><svg><title>icon-bag</title></svg></button>
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

  test("the buy button stays forbidden without the JSON", () => {
    expect(forbiddenReason(facts(visibleTextOf(tree(BUY_BUTTON))))).toBe(
      "botão de compra",
    );
  });
});

/** Body of `const visibleText = (node) => {...}` in the serialized code. */
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

describe("the page functions use the visible text", () => {
  // The functions that read element text each declare their own helper copy (serialization rule); it must equal the tested one.
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
    test(`${name}: helper copy equals the tested one`, () => {
      expect(helperBody(fn.toString())).toBe(pureBody);
    });
  }

  test("nobody else reads textContent (except the justified exceptions)", () => {
    // Exceptions: isProductPageInPage reads JSON-LD, domExcerptInPage only reads leaves, applyPatchInPage writes.
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

/** Body of an exported function, without whitespace. */
function fnBody(fn: (...args: never[]) => unknown): string {
  const src = fn.toString();
  return src.slice(src.indexOf("{")).replace(/\s+/g, "");
}

describe("who scrolls the page: a single copy of the criterion", () => {
  // Each scrolling function declares its own copy of `pageScrollerInPage` (serialization rule).
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
    test(`${name}: copy equals pageScrollerInPage`, () => {
      // The transpiler may inline a single-use arrow as an IIFE; the body must still match.
      expect(fn.toString().replace(/\s+/g, "")).toContain(canonical);
    });
  }

  test("nobody else scrolls with window.scrollTo(0, y)", () => {
    const offenders = Object.entries(scripts)
      .filter(([, v]) => typeof v === "function")
      .filter(([, v]) => /window\.scrollTo\(\s*0\s*,/.test(String(v)))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });
});

/** Fake page: a window that only scrolls with `behavior: "instant"` or not at all, and a <body> that may scroll. */
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
      // With smooth, scrolling only finishes later: right after, it is still 0.
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
  test("window with scroll-behavior smooth: scrolls immediately (instant)", () => {
    const f = fakeScrollPage({ windowScrolls: true, bodyScrolls: false });
    try {
      expect(scripts.scrollPageToInPage(1000)).toBe(1000);
      expect(f.win.scrollY).toBe(1000);
    } finally {
      f.restore();
    }
  });

  test("fashion store: the window does not move, the body scrolls", () => {
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

  test("past the end: returns where it stopped, not what was requested", () => {
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

  test("JSON-LD Product with offers.price", () => {
    const r = scripts.productPriceValues(
      [ld({ "@type": "Product", offers: { "@type": "Offer", price: 244.3 } })],
      [],
      [],
    );
    expect(r).toEqual({ values: [244.3], list: [], from: "json-ld" });
  });

  test("AggregateOffer: lowPrice and the inner list, without repeating", () => {
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

  test("offers as a list and list price in priceSpecification", () => {
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

  test("@graph with breadcrumb first; broken JSON does not blow up", () => {
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

  test("a list of other products is not this item's price", () => {
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

  test("no JSON-LD: meta/itemprop", () => {
    expect(scripts.productPriceValues([], ["244.30"], [])).toEqual({
      values: [244.3],
      list: [],
      from: "meta",
    });
  });

  test("only the dataLayer view_item has the value", () => {
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

  test('"1.998" is a thousands separator, not 1,998', () => {
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

  test("nothing declared: empty", () => {
    expect(scripts.productPriceValues([], [], undefined)).toEqual({
      values: [],
      list: [],
      from: null,
    });
  });
});

describe("moneyHasValue", () => {
  test("the page format: 244.3 → 244,30", () => {
    expect(scripts.moneyHasValue("R$ 244,30", [244.3])).toBe(true);
    expect(scripts.moneyHasValue("R$ 349,00R$ 244,30", [244.3])).toBe(true);
    expect(scripts.moneyHasValue("$244.30", [244.3])).toBe(true);
  });

  test("thousands with dot or comma", () => {
    expect(scripts.moneyHasValue("R$ 1.299,90", [1299.9])).toBe(true);
    expect(scripts.moneyHasValue("$1,299.90", [1299.9])).toBe(true);
  });

  test("round value without cents (R$ 780)", () => {
    expect(scripts.moneyHasValue("R$ 780", [780])).toBe(true);
    expect(scripts.moneyHasValue("R$ 780,00", [780])).toBe(true);
  });

  test("does not match part of another number", () => {
    expect(scripts.moneyHasValue("R$ 1.244,30", [244.3])).toBe(false);
    expect(scripts.moneyHasValue("10x de R$ 24,43", [244.3])).toBe(false);
    expect(scripts.moneyHasValue("R$ 780,50", [780])).toBe(false);
    expect(scripts.moneyHasValue("R$ 335,30", [244.3])).toBe(false);
  });
});

describe("pickTopCandidate", () => {
  test("the topmost wins over the largest (the one on the photo, not the one on the sheet)", () => {
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

  test("a fixed bar does not count", () => {
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

  test("height tie: the smallest for the price, the largest for the button", () => {
    const tie = [
      { y: 699, area: 200 * 20, pinned: false },
      { y: 700, area: 80 * 20, pinned: false },
    ];
    expect(scripts.pickTopCandidate(tie, "small")).toBe(1);
    expect(scripts.pickTopCandidate(tie, "large")).toBe(0);
  });
});

describe("measurePdpInPage: copies of the price and button helpers", () => {
  const src = scripts.measurePdpInPage.toString().replace(/\s+/g, "");
  for (const fn of [
    scripts.productPriceValues,
    scripts.moneyHasValue,
    scripts.pickTopCandidate,
  ]) {
    test(`${fn.name}: identical copy`, () => {
      expect(src).toContain(fnBody(fn as (...a: never[]) => unknown));
    });
  }
});

describe("cycle 6 review", () => {
  test("labelTextOf: hidden tooltip stays out of the size label", () => {
    const t = tree([
      "ul",
      ["li", "PP"],
      ["li", "P"],
      ["div", "vendido por parceiro. não elegível a promoções."],
    ]);
    const hidden = (n: TextTreeNode) => n.localName === "div";
    expect(scripts.labelTextOf(t, hidden)).toBe("PPP");
    // The click lock still reads everything.
    expect(visibleTextOf(t)).toContain("vendido por parceiro");
  });

  test("labelText: the copies equal the tested one", () => {
    const canonical = fnBody(scripts.labelTextOf);
    for (const fn of [
      scripts.measurePdpInPage,
      scripts.elementLabelsInPage,
      scripts.elementFactsInPage,
    ]) {
      expect(fn.toString().replace(/\s+/g, "")).toContain(canonical);
    }
  });

  test("isBuyText: favorites and wishlist are not a purchase", () => {
    expect(scripts.isBuyText("comprar")).toBe(true);
    expect(scripts.isBuyText("Adicionar à Sacola")).toBe(true);
    expect(scripts.isBuyText("Adicionar aos favoritos")).toBe(false);
    expect(scripts.isBuyText("Adicionar à lista de desejos")).toBe(false);
    expect(scripts.isBuyText("Add to wishlist")).toBe(false);
    expect(scripts.isBuyText("x".repeat(30) + " comprar agora")).toBe(false);
  });

  test("priceMatches: the sale price beats the struck-through one; the list price only counts without a sale", () => {
    const has = scripts.moneyHasValue;
    const cands = [
      { text: "R$ 349,00", struck: true },
      { text: "R$ 244,30", struck: false },
    ];
    expect(scripts.priceMatches(cands, [244.3], [349], has)).toEqual([1]);
    // The struck-through sale value (a promo the store strikes by mistake) does not count.
    expect(
      scripts.priceMatches(
        [{ text: "R$ 244,30", struck: true }],
        [244.3],
        [],
        has,
      ),
    ).toEqual([]);
    // Without the sale price on the page: the list price, even if struck through.
    expect(scripts.priceMatches([cands[0]!], [244.3], [349], has)).toEqual([0]);
  });

  test("measurePdpInPage: copies of isBuyText and priceMatches", () => {
    const src = scripts.measurePdpInPage.toString().replace(/\s+/g, "");
    expect(src).toContain(fnBody(scripts.isBuyText));
    expect(src).toContain(fnBody(scripts.priceMatches));
  });

  test("scroller: an off-screen drawer is not the page", () => {
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

describe("navigationOf: where the click leads", () => {
  /** Minimal tree: each node knows its parent, tag and attributes. */
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

  test("the store search submit leads to /buscar", () => {
    const form = node("form", { action: "/buscar" });
    const submit = node("button", { type: "submit" }, form);
    const svg = node("svg", {}, submit);
    expect(navigationOf(wrap(submit), here)).toBe("/buscar");
    // A click on the icon inside the button anchors on the icon.
    expect(navigationOf(wrap(svg), here)).toBe("/buscar");
  });

  test("button without type inside a form submits; type=button does not", () => {
    const form = node("form", {});
    expect(navigationOf(wrap(node("button", {}, form)), here)).toBe("/");
    expect(
      navigationOf(wrap(node("button", { type: "button" }, form)), here),
    ).toBe("");
  });

  test("button outside a form and label do not change page", () => {
    expect(navigationOf(wrap(node("button", { type: "submit" })), here)).toBe(
      "",
    );
    expect(navigationOf(wrap(node("label", { for: "x" })), here)).toBe("");
  });

  test("link: path; anchor and javascript do not count; another site yields the host", () => {
    const a = (href: string) => wrap(node("img", {}, node("a", { href })));
    expect(navigationOf(a("/colecao/vestidos?x=1"), here)).toBe(
      "/colecao/vestidos",
    );
    expect(navigationOf(a("#topo"), here)).toBe("");
    expect(navigationOf(a("javascript:void(0)"), here)).toBe("");
    expect(navigationOf(a("https://wa.me/55"), here)).toBe("wa.me/55");
  });

  test("copy inside elementLabelsInPage equals the tested one", () => {
    const canonical = fnBody(navigationOf);
    expect(
      scripts.elementLabelsInPage.toString().replace(/\s+/g, ""),
    ).toContain(canonical);
  });
});
