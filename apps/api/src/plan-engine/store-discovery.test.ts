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

describe("classifyPath: o que a URL diz da página", () => {
  test("padrões de PDP das plataformas", () => {
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

  test("/products/ fora da raiz não é PDP", () => {
    expect(classifyPath("/content/products/editorial")).not.toBe("pdp");
    expect(classifyPath("/mobile/products/br/x")).not.toBe("pdp");
  });

  test("talvez PDP: slug.html, slug com código, card com foto", () => {
    expect(classifyPath("/camisa-de-linho-azul.html")).toBe("maybe");
    expect(classifyPath("/camisa-linho-123456")).toBe("maybe");
    expect(
      classifyPath("/camisa-de-linho-azul", { image: true, zone: "main" }),
    ).toBe("maybe");
    // O mesmo slug sem foto, ou no menu, é vitrine.
    expect(classifyPath("/camisa-de-linho-azul")).toBe("listing");
    expect(
      classifyPath("/camisa-de-linho-azul", { image: true, zone: "nav" }),
    ).toBe("listing");
  });

  test("coleção e campanha com foto continuam vitrine", () => {
    expect(
      classifyPath("/colecao-verao-praia", { image: true, zone: "main" }),
    ).toBe("listing");
    expect(classifyPath("/feminino.html")).toBe("listing");
  });

  test("institucional, conta, busca e arquivo ficam de fora", () => {
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
    // "sobre" é palavra inteira: sobretudo é roupa.
    expect(classifyPath("/sobretudos")).toBe("listing");
  });
});

describe("classifyStoreLinks", () => {
  test("menu antes do conteúdo, rodapé por último", () => {
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

  test("de fora da loja, repetido, âncora e query não contam duas vezes", () => {
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

  test("grade de cards com slug solto conta como lista de produtos", () => {
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

  test("teto de 12 por balde", () => {
    const many = Array.from({ length: 30 }, (_, i) => a(`/item-${i}/p`));
    expect(classifyStoreLinks(many, ORIGIN).pdp.length).toBe(12);
  });
});

describe("termFromLinks: termo de busca tirado do menu do concorrente", () => {
  test("o primeiro item do menu com cara de tipo de produto", () => {
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

  test("sem texto (ícone): o fim do caminho", () => {
    expect(termFromLinks([a("/feminino/calcas-jeans", "nav")], ORIGIN)).toBe(
      "calcas jeans",
    );
  });

  test("nada que sirva", () => {
    expect(
      termFromLinks(
        [a("/minha-conta", "nav", { text: "Entrar" }), a("/x/p")],
        ORIGIN,
      ),
    ).toBeNull();
  });
});

describe("searchRouteFromForms: a busca que a home declara", () => {
  const page = `${ORIGIN}/`;
  const form = (
    action: string,
    inputs: RawSearchForm["inputs"],
    method = "get",
  ): RawSearchForm => ({ action, method, inputs });

  test("input type=search, action relativa", () => {
    expect(
      searchRouteFromForms(
        [form("busca", [{ name: "termo", type: "search", value: "" }])],
        `${ORIGIN}/feminino/`,
      ),
    ).toBe(`${ORIGIN}/feminino/busca?termo={q}`);
  });

  test("input pelo nome (ft, q…), action absoluta no caminho", () => {
    expect(
      searchRouteFromForms(
        [form("/busca", [{ name: "ft", type: "text", value: "" }])],
        page,
      ),
    ).toBe(`${ORIGIN}/busca?ft={q}`);
  });

  test("action vazia: a própria página; campos escondidos vão junto", () => {
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

  test("pula newsletter, POST e action de outro domínio", () => {
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

  test("www e apex são a mesma loja", () => {
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

describe("detectPlatform e searchRoutes: a rota de cada plataforma", () => {
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
    test(`${platform}: a rota dela logo depois da do formulário`, () => {
      expect(detectPlatform(html)).toBe(platform);
      const routes = searchRoutes({ pageUrl: `${ORIGIN}/`, forms: [], html });
      expect(routes[0]).toBe(route);
      // As comuns continuam na fila, sem repetir.
      expect(new Set(routes).size).toBe(routes.length);
      expect(routes).toContain(`${ORIGIN}/busca?q={q}`);
    });
  }

  test("formulário primeiro; plataforma desconhecida: as comuns", () => {
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

describe("searchOutcome: o que a rota de busca respondeu", () => {
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

  test("lista produtos", () => {
    expect(searchOutcome({ ...base, links: grid })).toBe("ok");
  });

  test("404, ou redirecionou pra home", () => {
    expect(searchOutcome({ ...base, links: grid, status: 404 })).toBe(
      "missing",
    );
    expect(searchOutcome({ ...base, links: grid, landed: `${ORIGIN}/` })).toBe(
      "missing",
    );
    // `/?s=vestido` é busca, não home.
    expect(
      searchOutcome({ ...base, links: grid, landed: `${ORIGIN}/?s=vestido` }),
    ).toBe("ok");
  });

  test("nenhum resultado pelo termo (sem acento, qualquer caixa)", () => {
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

  test("carrinho vazio numa página qualquer não é busca sem resultado", () => {
    expect(
      searchOutcome({
        ...base,
        heading: "Loja Exemplo",
        text: `Sacola: nenhum produto no carrinho. ${"Novidades da semana ".repeat(10)} Vestido de festa`,
      }),
    ).toBe("missing");
    // "10 produtos" não é "0 produtos".
    expect(
      searchOutcome({ ...base, heading: "vestido", text: "10 produtos" }),
    ).toBe("no_product_links");
  });

  test("respondeu pelo termo sem link de produto reconhecível", () => {
    expect(
      searchOutcome({ ...base, heading: "Resultados para vestido | Loja" }),
    ).toBe("no_product_links");
  });
});

describe("searchFailureMessage: a lacuna nomeia a etapa", () => {
  const d = "concorrente-exemplo.com.br";

  test("nenhuma rota é a busca", () => {
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

  test("busca sem resultado, também com o termo do concorrente", () => {
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

  test("resultado sem link de produto", () => {
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

  test("sem tempo", () => {
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
