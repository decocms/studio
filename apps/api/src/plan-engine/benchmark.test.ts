import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { findListingPage, findSearchPage, pdpCandidates } from "./benchmark.ts";
import { __setPageWaitForTesting } from "./browser.ts";
import {
  isProductPageInPage,
  searchHintsInPage,
  storeLinksInPage,
  wallSnapshotInPage,
} from "./page-scripts.ts";
import type { BrowserPage, BrowserPort } from "./ports.ts";
import type { LinkZone, RawLink, SearchHints } from "./store-discovery.ts";

let restoreWait: () => void;
beforeAll(() => {
  restoreWait = __setPageWaitForTesting(async () => {});
});
afterAll(() => restoreWait());

const ORIGIN = "https://concorrente-exemplo.com.br";
const HOME = `${ORIGIN}/`;

/** Um link da página falsa. */
function a(
  path: string,
  zone: LinkZone = "main",
  extra: Partial<RawLink> = {},
): RawLink {
  return { href: `${ORIGIN}${path}`, zone, text: "", image: false, ...extra };
}

interface FakePage {
  links?: RawLink[];
  text?: string;
  heading?: string;
  hints?: Omit<SearchHints, "pageUrl">;
  /** Erro ao ler a página (ex.: o desafio anti-robô recarregou). */
  readError?: string;
  status?: number;
  product?: boolean;
  /** A navegação cai aqui (ex.: `chrome-error://chromewebdata/`). */
  landsOn?: string;
  gotoError?: string;
}

/**
 * Navegador falso: cada URL responde o que o mapa manda (a chave é a URL sem
 * o `html`, exata; senão origem + caminho).
 */
function fakeBrowser(site: Record<string, FakePage>) {
  const visited: string[] = [];
  const browser: BrowserPort = {
    newPage: async () => {
      let current = "about:blank";
      let spec: FakePage = {};
      const answer = (fn: unknown): unknown => {
        if (fn === wallSnapshotInPage) return { links: 50, html: "", text: "" };
        if (fn === storeLinksInPage) {
          if (spec.readError) throw new Error(spec.readError);
          return {
            origin: new URL(current).origin,
            links: spec.links ?? [],
            text: spec.text ?? "",
            heading: spec.heading ?? "",
          };
        }
        if (fn === searchHintsInPage)
          return {
            pageUrl: current,
            forms: spec.hints?.forms ?? [],
            html: spec.hints?.html ?? "",
          };
        if (fn === isProductPageInPage) return spec.product === true;
        if (String(fn).includes("contentType")) return "text/html";
        return undefined;
      };
      const page: BrowserPage = {
        viewport: { width: 390, height: 844, deviceScaleFactor: 2 },
        goto: async (url: string) => {
          visited.push(url);
          const u = new URL(url);
          u.searchParams.delete("html");
          spec = site[u.href] ?? site[`${u.origin}${u.pathname}`] ?? {};
          current = spec.landsOn ?? url;
          return spec.gotoError
            ? { status: null, error: spec.gotoError }
            : { status: spec.status ?? 200, error: null };
        },
        url: () => current,
        evaluate: async <A extends unknown[], R>(
          fn: (...args: A) => R,
          ..._args: A
        ): Promise<Awaited<R>> => answer(fn) as Awaited<R>,
        reload: async () => {},
        screenshot: async () => new Uint8Array(),
        mouseMove: async () => {},
        click: async () => ({ navigation: null }),
        blockedRequests: () => 0,
        close: async () => {},
      };
      return page;
    },
    fetch: async () => {
      throw new TypeError("sem rede");
    },
  };
  return { browser, visited };
}

/** fetch falso: robots e sitemaps por URL; o resto é 404. */
function fakeFetch(files: Record<string, string>) {
  const asked: string[] = [];
  const fetcher = async (input: string) => {
    const url = String(input);
    asked.push(url);
    const body = files[url];
    return body === undefined
      ? new Response("", { status: 404 })
      : new Response(body, { status: 200 });
  };
  return { fetcher, asked };
}

const noSitemap = fakeFetch({}).fetcher;

async function collect(gen: AsyncGenerator<string, void>): Promise<string[]> {
  const out: string[] = [];
  for await (const u of gen) out.push(u);
  return out;
}

describe("pdpCandidates", () => {
  test("concorrente: nenhuma URL aberta leva o ?html=1", async () => {
    const f = fakeBrowser({
      [HOME]: { links: [a("/vestidos", "nav")] },
      [`${ORIGIN}/vestidos`]: { links: [a("/vestido-midi/p")] },
    });
    const links = await collect(
      pdpCandidates(f.browser, HOME, { ownStore: false, fetcher: noSitemap }),
    );
    expect(links).toEqual([`${ORIGIN}/vestido-midi/p`]);
    expect(f.visited.length).toBe(2);
    for (const url of f.visited) expect(url).not.toContain("html=1");
  });

  test("loja analisada: continua pedindo o HTML", async () => {
    const f = fakeBrowser({
      [HOME]: { links: [a("/vestidos", "nav")] },
      [`${ORIGIN}/vestidos`]: { links: [a("/vestido-midi/p")] },
    });
    await collect(
      pdpCandidates(f.browser, HOME, { ownStore: true, fetcher: noSitemap }),
    );
    for (const url of f.visited) expect(url).toContain("html=1");
  });

  test("domínio que não existe: a lacuna nomeia a falha de navegação", async () => {
    const f = fakeBrowser({
      [HOME]: {
        landsOn: "chrome-error://chromewebdata/",
        gotoError: `net::ERR_NAME_NOT_RESOLVED at ${HOME}`,
      },
    });
    await expect(
      collect(
        pdpCandidates(f.browser, HOME, { ownStore: false, fetcher: noSitemap }),
      ),
    ).rejects.toThrow(`não abriu ${HOME}: net::ERR_NAME_NOT_RESOLVED`);
  });

  test("vitrine do menu antes da do rodapé; vitrine que não abre é pulada", async () => {
    const f = fakeBrowser({
      [HOME]: {
        links: [
          a("/institucional/sobre", "footer"),
          a("/presente", "footer"),
          a("/quebrada", "nav"),
          a("/blusas", "nav"),
        ],
      },
      [`${ORIGIN}/quebrada`]: {
        landsOn: "chrome-error://chromewebdata/",
        gotoError: "net::ERR_CONNECTION_RESET",
      },
      [`${ORIGIN}/blusas`]: { links: [a("/produtos/blusa-listrada")] },
    });
    const links = await collect(
      pdpCandidates(f.browser, HOME, { ownStore: false, fetcher: noSitemap }),
    );
    expect(links[0]).toBe(`${ORIGIN}/produtos/blusa-listrada`);
    expect(f.visited.slice(0, 3)).toEqual([
      HOME,
      `${ORIGIN}/quebrada`,
      `${ORIGIN}/blusas`,
    ]);
  });

  test("só abre vitrine quando quem consome pede mais", async () => {
    const f = fakeBrowser({
      [HOME]: { links: [a("/camisa-polo/p"), a("/vestidos", "nav")] },
    });
    for await (const url of pdpCandidates(f.browser, HOME, {
      ownStore: false,
      fetcher: noSitemap,
    })) {
      expect(url).toBe(`${ORIGIN}/camisa-polo/p`);
      break;
    }
    expect(f.visited).toEqual([HOME]);
  });

  test("sem link de PDP na home nem nas vitrines: cai no sitemap", async () => {
    const f = fakeBrowser({
      [HOME]: { links: [a("/vestidos", "nav")] },
      [`${ORIGIN}/vestidos`]: { links: [a("/vestidos/curtos", "main")] },
    });
    const { fetcher, asked } = fakeFetch({
      [`${ORIGIN}/robots.txt`]: `User-agent: *\nSitemap: ${ORIGIN}/sitemap.xml\n`,
      [`${ORIGIN}/sitemap.xml`]: `<urlset><url><loc>${ORIGIN}/vestido-longo-floral-12345</loc></url></urlset>`,
    });
    const links = await collect(
      pdpCandidates(f.browser, HOME, { ownStore: false, fetcher }),
    );
    expect(links).toEqual([`${ORIGIN}/vestido-longo-floral-12345`]);
    expect(asked).toEqual([`${ORIGIN}/robots.txt`, `${ORIGIN}/sitemap.xml`]);
  });

  test("prazo vencido: não abre vitrine nem busca sitemap", async () => {
    const f = fakeBrowser({ [HOME]: { links: [a("/vestidos", "nav")] } });
    const { fetcher, asked } = fakeFetch({});
    const links = await collect(
      pdpCandidates(f.browser, HOME, {
        ownStore: false,
        deadline: Date.now() - 1,
        fetcher,
      }),
    );
    expect(links).toEqual([]);
    expect(f.visited).toEqual([HOME]);
    expect(asked).toEqual([]);
  });
});

describe("findListingPage", () => {
  const grid = [
    a("/produtos/a"),
    a("/produtos/b"),
    a("/produtos/c"),
    a("/produtos/d"),
  ];

  test("a primeira vitrine que lista produto, do menu", async () => {
    const f = fakeBrowser({
      [HOME]: {
        links: [a("/trabalhe-conosco", "footer"), a("/saias", "nav")],
      },
      [`${ORIGIN}/saias`]: { links: grid },
    });
    const found = await findListingPage(
      f.browser,
      "concorrente-exemplo.com.br",
      Date.now() + 60_000,
      noSitemap,
    );
    expect(found.url).toBe(`${ORIGIN}/saias`);
  });

  test("sem vitrine com produto na home: categorias do sitemap", async () => {
    const f = fakeBrowser({
      [HOME]: { links: [a("/lookbook-verao", "nav")] },
      [`${ORIGIN}/calcas`]: { links: grid },
    });
    const { fetcher } = fakeFetch({
      [`${ORIGIN}/sitemap.xml`]: `<sitemapindex><sitemap><loc>${ORIGIN}/sitemap/category-0.xml</loc></sitemap></sitemapindex>`,
      [`${ORIGIN}/sitemap/category-0.xml`]: `<urlset><url><loc>${ORIGIN}/calcas</loc></url></urlset>`,
    });
    const found = await findListingPage(
      f.browser,
      "concorrente-exemplo.com.br",
      Date.now() + 60_000,
      fetcher,
    );
    expect(found.url).toBe(`${ORIGIN}/calcas`);
  });

  test("nada que liste produto: a lacuna conta o que abriu", async () => {
    const f = fakeBrowser({ [HOME]: { links: [a("/saias", "nav")] } });
    await expect(
      findListingPage(
        f.browser,
        "concorrente-exemplo.com.br",
        Date.now() + 60_000,
        noSitemap,
      ),
    ).rejects.toThrow(
      "nenhuma vitrine com produtos em concorrente-exemplo.com.br (1 da home e 0 do sitemap abertas)",
    );
  });

  test("home sem vitrine e sem sitemap", async () => {
    const f = fakeBrowser({ [HOME]: { links: [] } });
    await expect(
      findListingPage(
        f.browser,
        "concorrente-exemplo.com.br",
        Date.now() + 60_000,
        noSitemap,
      ),
    ).rejects.toThrow(
      "nenhuma vitrine na home nem no sitemap de concorrente-exemplo.com.br",
    );
  });
});

describe("findSearchPage", () => {
  const DOMAIN = "concorrente-exemplo.com.br";
  const grid = [
    a("/produtos/a"),
    a("/produtos/b"),
    a("/produtos/c"),
    a("/produtos/d"),
  ];
  const later = () => Date.now() + 60_000;
  const searchForm = {
    forms: [
      {
        action: "/procurar",
        method: "get",
        inputs: [{ name: "termo", type: "search", value: "" }],
      },
    ],
    html: "",
  };

  test("a rota do formulário da home vem primeiro", async () => {
    const f = fakeBrowser({
      [HOME]: { hints: searchForm },
      [`${ORIGIN}/procurar?termo=vestido`]: { links: grid },
    });
    const found = await findSearchPage(f.browser, DOMAIN, "vestido", later());
    expect(found.url).toBe(`${ORIGIN}/procurar?termo=vestido`);
    expect(f.visited).toEqual([HOME, `${ORIGIN}/procurar?termo=vestido`]);
  });

  test("VTEX IO: a rota da plataforma; rota que não abre não derruba as outras", async () => {
    const f = fakeBrowser({
      [HOME]: { hints: { forms: [], html: "<script>__RUNTIME__</script>" } },
      [`${ORIGIN}/vestido?_q=vestido&map=ft`]: {
        landsOn: "chrome-error://chromewebdata/",
        gotoError: "net::ERR_TOO_MANY_REDIRECTS",
      },
      [`${ORIGIN}/search?q=vestido`]: { status: 404 },
      [`${ORIGIN}/s?q=vestido`]: { links: grid },
    });
    const found = await findSearchPage(f.browser, DOMAIN, "vestido", later());
    expect(found.url).toBe(`${ORIGIN}/s?q=vestido`);
    expect(f.visited.slice(1)).toEqual([
      `${ORIGIN}/vestido?_q=vestido&map=ft`,
      `${ORIGIN}/search?q=vestido`,
      `${ORIGIN}/s?q=vestido`,
    ]);
  });

  test("o termo da loja não acha nada: uma vez com o termo do menu, na mesma rota", async () => {
    const f = fakeBrowser({
      [HOME]: {
        hints: searchForm,
        links: [a("/sapatos", "nav", { text: "Sapatos" })],
      },
      [`${ORIGIN}/procurar?termo=vestido`]: {
        text: "Não encontramos resultados para vestido",
      },
      [`${ORIGIN}/procurar?termo=sapatos`]: { links: grid },
    });
    const found = await findSearchPage(f.browser, DOMAIN, "vestido", later());
    expect(found.url).toBe(`${ORIGIN}/procurar?termo=sapatos`);
    expect(f.visited.length).toBe(3);
  });

  test("sem termo da loja: usa o do menu", async () => {
    const f = fakeBrowser({
      [HOME]: {
        hints: searchForm,
        links: [a("/sapatos", "nav", { text: "Sapatos" })],
      },
      [`${ORIGIN}/procurar?termo=sapatos`]: { links: grid },
    });
    const found = await findSearchPage(f.browser, DOMAIN, null, later());
    expect(found.url).toBe(`${ORIGIN}/procurar?termo=sapatos`);
  });

  test("nenhum dos dois termos acha: a lacuna diz que a busca existe e veio vazia", async () => {
    const f = fakeBrowser({
      [HOME]: {
        hints: searchForm,
        links: [a("/sapatos", "nav", { text: "Sapatos" })],
      },
      [`${ORIGIN}/procurar?termo=vestido`]: {
        text: "Nenhum resultado para vestido",
      },
      [`${ORIGIN}/procurar?termo=sapatos`]: {
        text: "Nenhum resultado para sapatos",
      },
    });
    await expect(
      findSearchPage(f.browser, DOMAIN, "vestido", later()),
    ).rejects.toThrow(
      `a busca de ${DOMAIN} (/procurar?termo=…) não achou produto pra "vestido" nem pra "sapatos"`,
    );
  });

  test("nenhuma rota é a busca: a lacuna lista as testadas", async () => {
    const f = fakeBrowser({ [HOME]: { hints: { forms: [], html: "" } } });
    await expect(
      findSearchPage(f.browser, DOMAIN, "vestido", later()),
    ).rejects.toThrow(
      `rota de busca de ${DOMAIN} não encontrada (testadas: /search?q=…, /s?q=…, /busca?q=…, /…?_q=…&map=ft, /busca?ft=…)`,
    );
    // Teto de rotas por loja.
    expect(f.visited.length).toBe(6);
  });

  test("desafio anti-robô numa rota encerra a loja", async () => {
    const f = fakeBrowser({
      [HOME]: { hints: { forms: [], html: "" } },
      [`${ORIGIN}/search?q=vestido`]: {
        readError: "Execution context was destroyed",
      },
    });
    await expect(
      findSearchPage(f.browser, DOMAIN, "vestido", later()),
    ).rejects.toThrow("Execution context was destroyed");
    expect(f.visited.length).toBe(2);
  });

  test("prazo vencido: não testa rota", async () => {
    const f = fakeBrowser({ [HOME]: { hints: { forms: [], html: "" } } });
    await expect(
      findSearchPage(f.browser, DOMAIN, "vestido", Date.now() - 1),
    ).rejects.toThrow(`sem tempo pra testar a busca de ${DOMAIN}`);
  });
});
