import { describe, expect, test } from "bun:test";
import {
  classifyPath,
  classifyStoreLinks,
  detectPlatform,
  fillRoute,
  type LinkZone,
  type Platform,
  productCount,
  type RawLink,
  type RawSearchForm,
  routeLabel,
  searchFailureMessage,
  searchOutcome,
  searchRouteFromForms,
  searchRoutes,
  type StoreLinks,
  termFromLinks,
} from "./store-discovery.ts";

const ORIGIN = "https://loja-exemplo.com.br";

function a(
  path: string,
  zone: LinkZone = "main",
  extra: Partial<RawLink> = {},
): RawLink {
  const href = path.startsWith("http") ? path : `${ORIGIN}${path}`;
  return { href, zone, text: "", image: false, ...extra };
}

describe("classifyPath: what the URL says about the page", () => {
  test("platform PDP patterns", () => {
    for (const path of [
      "/vestido-midi-floral/p",
      "/produto/camisa-linho",
      "/produtos/camisa-linho",
      "/products/camisa-linho",
      "/pt-br/products/camisa-linho",
      "/collections/verao/products/camisa-linho",
      "/tenis-corrida-leve/123456.html",
      "/camisa-linho-p1234567.html",
    ]) {
      expect([path, classifyPath(path)]).toEqual([path, "pdp"]);
    }
  });

  test("/products/ outside the root is not a PDP", () => {
    expect(classifyPath("/content/products/editorial")).not.toBe("pdp");
    expect(classifyPath("/mobile/products/br/x")).not.toBe("pdp");
  });

  test("maybe PDP: slug.html, slug with code, card with photo", () => {
    expect(classifyPath("/camisa-de-linho-azul.html")).toBe("maybe");
    expect(classifyPath("/camisa-linho-123456")).toBe("maybe");
    expect(
      classifyPath("/camisa-de-linho-azul", { image: true, zone: "main" }),
    ).toBe("maybe");
    // The same slug without a photo, or in the menu, is a showcase.
    expect(classifyPath("/camisa-de-linho-azul")).toBe("listing");
    expect(
      classifyPath("/camisa-de-linho-azul", { image: true, zone: "nav" }),
    ).toBe("listing");
  });

  test("collection and campaign with photo remain showcases", () => {
    expect(
      classifyPath("/colecao-verao-praia", { image: true, zone: "main" }),
    ).toBe("listing");
    expect(classifyPath("/feminino.html")).toBe("listing");
  });

  test("institutional, account, search and file stay out", () => {
    for (const path of [
      "/",
      "/institucional/sobre",
      "/trocas-e-devolucoes",
      "/politica-de-privacidade",
      "/minha-conta",
      "/busca",
      "/catalogsearch/result",
      "/catalogo.pdf",
    ]) {
      expect([path, classifyPath(path)]).toEqual([path, null]);
    }
    // "sobre" is a whole word: "sobretudo" is clothing.
    expect(classifyPath("/sobretudos")).toBe("listing");
  });
});

describe("classifyStoreLinks", () => {
  test("menu before content, footer last", () => {
    const out = classifyStoreLinks(
      [
        a("/trabalhe-conosco", "footer"),
        a("/presentes", "footer"),
        a("/destaques", "main"),
        a("/vestidos", "nav"),
        a("/blusas", "header"),
      ],
      ORIGIN,
    );
    expect(out.listing).toEqual([
      `${ORIGIN}/vestidos`,
      `${ORIGIN}/blusas`,
      `${ORIGIN}/destaques`,
      `${ORIGIN}/presentes`,
    ]);
  });

  test("outside the store, repeated, anchor and query do not count twice", () => {
    const out = classifyStoreLinks(
      [
        a("https://outra-loja-exemplo.com.br/x/p"),
        a("/camisa/p#galeria"),
        a("/camisa/p?cor=azul"),
        a("https://www.loja-exemplo.com.br/saia/p"),
        a("mailto:contato@loja-exemplo.com.br"),
      ],
      ORIGIN,
    );
    expect(out.pdp).toEqual([
      `${ORIGIN}/camisa/p`,
      "https://www.loja-exemplo.com.br/saia/p",
    ]);
  });

  test("card grid with a bare slug counts as a product list", () => {
    const card = (slug: string) => a(slug, "main", { image: true });
    const out = classifyStoreLinks(
      [
        card("/camisa-de-linho-azul"),
        card("/saia-midi-plissada-verde"),
        card("/blusa-de-tricot-cru"),
        card("/calca-pantalona-de-alfaiataria"),
        a("/saias", "nav"),
      ],
      ORIGIN,
    );
    expect(out.pdp).toEqual([]);
    expect(out.maybePdp.length).toBe(4);
    expect(productCount(out)).toBe(4);
    expect(out.listing).toEqual([`${ORIGIN}/saias`]);
  });

  test("cap of 12 per bucket", () => {
    const many = Array.from({ length: 30 }, (_, i) => a(`/item-${i}/p`));
    expect(classifyStoreLinks(many, ORIGIN).pdp.length).toBe(12);
  });
});

describe("termFromLinks: search term taken from a competitor's menu", () => {
  test("the first menu item that looks like a product type", () => {
    expect(
      termFromLinks(
        [
          a("/presentes", "footer", { text: "Presentes" }),
          a("/novidades", "nav", { text: "Novidades" }),
          a("/vestidos", "nav", { text: "Vestidos" }),
        ],
        ORIGIN,
      ),
    ).toBe("vestidos");
  });

  test("without text (icon): the end of the path", () => {
    expect(termFromLinks([a("/feminino/calcas-jeans", "nav")], ORIGIN)).toBe(
      "calcas jeans",
    );
  });

  test("nothing usable", () => {
    expect(
      termFromLinks(
        [a("/minha-conta", "nav", { text: "Entrar" }), a("/x/p")],
        ORIGIN,
      ),
    ).toBeNull();
  });
});

describe("searchRouteFromForms: the search the home declares", () => {
  const page = `${ORIGIN}/`;
  const form = (
    action: string,
    inputs: RawSearchForm["inputs"],
    method = "get",
  ): RawSearchForm => ({ action, method, inputs });

  test("input type=search, relative action", () => {
    expect(
      searchRouteFromForms(
        [form("busca", [{ name: "termo", type: "search", value: "" }])],
        `${ORIGIN}/feminino/`,
      ),
    ).toBe(`${ORIGIN}/feminino/busca?termo={q}`);
  });

  test("input by name (ft, q...), absolute action on the path", () => {
    expect(
      searchRouteFromForms(
        [form("/busca", [{ name: "ft", type: "text", value: "" }])],
        page,
      ),
    ).toBe(`${ORIGIN}/busca?ft={q}`);
  });

  test("empty action: the page itself; hidden fields come along", () => {
    expect(
      searchRouteFromForms(
        [
          form("", [
            { name: "post_type", type: "hidden", value: "product" },
            { name: "s", type: "text", value: "" },
          ]),
        ],
        page,
      ),
    ).toBe(`${ORIGIN}/?post_type=product&s={q}`);
  });

  test("skips newsletter, POST and another domain's action", () => {
    expect(
      searchRouteFromForms(
        [
          form("/newsletter", [{ name: "email", type: "email", value: "" }]),
          form("/busca", [{ name: "q", type: "search", value: "" }], "post"),
          form("https://busca-terceiro-exemplo.com/s", [
            { name: "q", type: "search", value: "" },
          ]),
          form("/pesquisa", [{ name: "query", type: "text", value: "" }]),
        ],
        page,
      ),
    ).toBe(`${ORIGIN}/pesquisa?query={q}`);
  });

  test("www and apex are the same store", () => {
    expect(
      searchRouteFromForms(
        [
          form("https://www.loja-exemplo.com.br/s", [
            { name: "q", type: "search", value: "" },
          ]),
        ],
        page,
      ),
    ).toBe("https://www.loja-exemplo.com.br/s?q={q}");
  });
});

describe("detectPlatform and searchRoutes: each platform's route", () => {
  const cases: Array<[string, Platform, string]> = [
    [
      `<script>window.__RUNTIME__ = {}</script><link href="/_v/segment/x">`,
      "vtex-io",
      `${ORIGIN}/{q}?_q={q}&map=ft`,
    ],
    [
      `<script src="/arquivos/loja.min.js"></script><script src="vtex.js"></script>`,
      "vtex-legacy",
      `${ORIGIN}/busca?ft={q}`,
    ],
    [
      `<script type="text/x-magento-init">{}</script>`,
      "magento",
      `${ORIGIN}/catalogsearch/result/?q={q}`,
    ],
    [
      `<link href="https://cdn.shopify.com/s/files/x.css">`,
      "shopify",
      `${ORIGIN}/search?q={q}`,
    ],
    [`<script src="/_frsh/js/main.js"></script>`, "deco", `${ORIGIN}/s?q={q}`],
  ];

  for (const [html, platform, route] of cases) {
    test(`${platform}: its route right after the form's`, () => {
      expect(detectPlatform(html)).toBe(platform);
      const routes = searchRoutes({ pageUrl: `${ORIGIN}/`, forms: [], html });
      expect(routes[0]).toBe(route);
      // The common ones stay in the queue, without repeats.
      expect(new Set(routes).size).toBe(routes.length);
      expect(routes).toContain(`${ORIGIN}/busca?q={q}`);
    });
  }

  test("form first; unknown platform: the common ones", () => {
    const routes = searchRoutes({
      pageUrl: `${ORIGIN}/`,
      forms: [
        {
          action: "/procurar",
          method: "get",
          inputs: [{ name: "q", type: "search", value: "" }],
        },
      ],
      html: "<html></html>",
    });
    expect(detectPlatform("<html></html>")).toBeNull();
    expect(routes.slice(0, 3)).toEqual([
      `${ORIGIN}/procurar?q={q}`,
      `${ORIGIN}/search?q={q}`,
      `${ORIGIN}/s?q={q}`,
    ]);
    expect(routes).toContain(`${ORIGIN}/{q}?_q={q}&map=ft`);
    expect(routes).toContain(`${ORIGIN}/busca?ft={q}`);
    expect(routes).toContain(`${ORIGIN}/catalogsearch/result/?q={q}`);
  });

  test("fillRoute e routeLabel", () => {
    const route = `${ORIGIN}/{q}?_q={q}&map=ft`;
    expect(fillRoute(route, "calça jeans")).toBe(
      `${ORIGIN}/cal%C3%A7a%20jeans?_q=cal%C3%A7a%20jeans&map=ft`,
    );
    expect(routeLabel(route)).toBe("/…?_q=…&map=ft");
  });
});

describe("searchOutcome: what the search route answered", () => {
  const none: StoreLinks = { pdp: [], maybePdp: [], listing: [] };
  const grid: StoreLinks = {
    pdp: ["a", "b", "c", "d"].map((x) => `${ORIGIN}/${x}/p`),
    maybePdp: [],
    listing: [],
  };
  const base = {
    status: 200,
    links: none,
    text: "",
    heading: "",
    term: "vestido",
  };

  test("lists products", () => {
    expect(searchOutcome({ ...base, links: grid })).toBe("ok");
  });

  test("404, or redirected to the home", () => {
    expect(searchOutcome({ ...base, links: grid, status: 404 })).toBe(
      "missing",
    );
    expect(searchOutcome({ ...base, links: grid, landed: `${ORIGIN}/` })).toBe(
      "missing",
    );
    // `/?s=vestido` is a search, not the home.
    expect(
      searchOutcome({ ...base, links: grid, landed: `${ORIGIN}/?s=vestido` }),
    ).toBe("ok");
  });

  test("no results for the term (accent- and case-insensitive)", () => {
    expect(
      searchOutcome({
        ...base,
        term: "calção",
        text: "Ops! Não encontramos resultados para CALCAO.",
      }),
    ).toBe("no_results");
    expect(
      searchOutcome({
        ...base,
        heading: "Busca: vestido",
        text: "0 produtos",
      }),
    ).toBe("no_results");
  });

  test("an empty cart on any page is not a search without results", () => {
    expect(
      searchOutcome({
        ...base,
        heading: "Loja Exemplo",
        text: `Sacola: nenhum produto no carrinho. ${"Novidades da semana ".repeat(10)} Vestido de festa`,
      }),
    ).toBe("missing");
    // "10 produtos" is not "0 produtos".
    expect(
      searchOutcome({ ...base, heading: "vestido", text: "10 produtos" }),
    ).toBe("no_product_links");
  });

  test("answered for the term without a recognizable product link", () => {
    expect(
      searchOutcome({ ...base, heading: "Resultados para vestido | Loja" }),
    ).toBe("no_product_links");
  });
});

describe("searchFailureMessage: the gap names the stage", () => {
  const d = "concorrente-exemplo.com.br";

  test("no route is the search", () => {
    expect(
      searchFailureMessage(
        d,
        [
          { route: "/search?q=…", term: "vestido", outcome: "missing" },
          { route: "/s?q=…", term: "vestido", outcome: "missing" },
        ],
        false,
      ),
    ).toBe(
      "rota de busca de concorrente-exemplo.com.br não encontrada (testadas: /search?q=…, /s?q=…)",
    );
  });

  test("search without results, also with the competitor's term", () => {
    expect(
      searchFailureMessage(
        d,
        [
          { route: "/search?q=…", term: "vestido", outcome: "missing" },
          { route: "/busca?ft=…", term: "vestido", outcome: "no_results" },
          { route: "/busca?ft=…", term: "sapatos", outcome: "no_results" },
        ],
        false,
      ),
    ).toBe(
      'a busca de concorrente-exemplo.com.br (/busca?ft=…) não achou produto pra "vestido" nem pra "sapatos"',
    );
  });

  test("result without a product link", () => {
    expect(
      searchFailureMessage(
        d,
        [{ route: "/s?q=…", term: "vestido", outcome: "no_product_links" }],
        false,
      ),
    ).toBe(
      'a busca de concorrente-exemplo.com.br respondeu pra "vestido" em /s?q=…, mas sem link de produto reconhecível',
    );
  });

  test("out of time", () => {
    expect(searchFailureMessage(d, [], true)).toBe(
      "sem tempo pra testar a busca de concorrente-exemplo.com.br",
    );
    expect(
      searchFailureMessage(
        d,
        [{ route: "/search?q=…", term: "vestido", outcome: "missing" }],
        true,
      ),
    ).toContain("acabou o tempo antes das outras rotas");
  });
});
