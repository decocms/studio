import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  __setPageWaitForTesting,
  BotWallError,
  browserFetcher,
  classifyBotWall,
  FULL_PAGE_MAX_HEIGHT,
  forceHtml,
  fullPageScale,
  htmlRetryUrl,
  isStatusBotWall,
  MAX_IMAGE_SIDE_PX,
  navigationFailure,
  openPage,
  PageOpenError,
  VIEWPORTS,
  withBrowser,
} from "./browser.ts";
import { fakeBrowser } from "./fixtures/fake-browser.ts";
import { wallSnapshotInPage } from "./page-scripts.ts";
import { type BrowserPort, BrowserSessionError } from "./ports.ts";

let restoreWait: () => void;
beforeAll(() => {
  restoreWait = __setPageWaitForTesting(async () => {});
});
afterAll(() => restoreWait());

describe("htmlRetryUrl (prints de 05/11 saíram em markdown)", () => {
  test("o redirect do apex derrubou o ?html=1: pede de novo com ele", () => {
    expect(htmlRetryUrl("https://www.loja-exemplo.com.br/vestido-1/p")).toBe(
      "https://www.loja-exemplo.com.br/vestido-1/p?html=1",
    );
  });

  test("caiu na rota de agente: tira o .md", () => {
    expect(htmlRetryUrl("https://www.loja-exemplo.com.br/vestido-1/p.md")).toBe(
      "https://www.loja-exemplo.com.br/vestido-1/p?html=1",
    );
  });

  test("o parâmetro sobreviveu, ou não é página http: nada a refazer", () => {
    expect(
      htmlRetryUrl(forceHtml("https://www.loja-exemplo.com.br/x/p")),
    ).toBeNull();
    expect(htmlRetryUrl("about:blank")).toBeNull();
    expect(htmlRetryUrl("chrome-error://chromewebdata/")).toBeNull();
  });
});

describe("fullPageScale (400 do modelo: imagem acima de 8.000px)", () => {
  test("celular a 2x com a página inteira cabe no teto", () => {
    const dsf = VIEWPORTS.mobile.deviceScaleFactor;
    const scale = fullPageScale(FULL_PAGE_MAX_HEIGHT, dsf);
    expect(FULL_PAGE_MAX_HEIGHT * dsf * scale).toBeLessThanOrEqual(
      MAX_IMAGE_SIDE_PX,
    );
    expect(FULL_PAGE_MAX_HEIGHT * dsf * scale).toBeLessThan(8_000);
  });

  test("página curta ou desktop a 1x não encolhe", () => {
    expect(fullPageScale(2_121, 2)).toBe(1);
    expect(
      fullPageScale(FULL_PAGE_MAX_HEIGHT, VIEWPORTS.desktop.deviceScaleFactor),
    ).toBe(1);
  });
});

describe("classifyBotWall (benchmark de 09/11: 4 de 5 concorrentes)", () => {
  const page = (
    html: string,
    extra: Partial<{ status: number; links: number; text: string }> = {},
  ) => ({
    status: 200,
    links: 0,
    text: "",
    html,
    ...extra,
  });

  test("os muros sondados em 10/11", () => {
    expect(
      classifyBotWall(
        page(
          `<meta http-equiv="refresh" content="5; URL='/br/?bm-verify=AAQ'" />`,
        ),
      ),
    ).toBe("Akamai");
    expect(
      classifyBotWall(
        page(`<script src="https://ct.captcha-delivery.com/i.js"></script>`, {
          status: 403,
        }),
      ),
    ).toBe("DataDome");
    expect(
      classifyBotWall(page("<title>Just a moment...</title>", { status: 403 })),
    ).toBe("Cloudflare");
    expect(
      classifyBotWall(
        page("<html>Reference #18.abc edgesuite.net</html>", {
          text: "Access Denied",
          status: 403,
        }),
      ),
    ).toBe("Akamai");
    expect(classifyBotWall(page("", { status: 429 }))).toBe("HTTP 429");
  });

  test("loja de verdade com script anti-robô carregado não é muro", () => {
    expect(
      classifyBotWall(
        page(
          `<script src="https://js.captcha-delivery.com/tags.js"></script>`,
          {
            links: 120,
          },
        ),
      ),
    ).toBeNull();
    expect(classifyBotWall(page("<html><body>loja</body></html>"))).toBeNull();
  });
});

describe("openPage com bloqueio de rastreio", () => {
  test("a página abre com o bloqueio pedido", async () => {
    const f = fakeBrowser(() => ({}));
    const block = (u: string) => u.includes("tracker");
    await openPage(f.browser, "https://loja-exemplo.com.br/p", "mobile", {
      blockRequest: block,
    });
    expect(f.blockers).toEqual([block]);
  });

  test("sem bloqueio, a página abre sem nenhum", async () => {
    const f = fakeBrowser(() => ({}));
    await openPage(f.browser, "https://loja-exemplo.com.br/p", "mobile");
    expect(f.blockers).toEqual([undefined]);
  });
});

describe("openPage: ?html=1 só na loja analisada", () => {
  test("loja analisada: pede ?html=1", async () => {
    const f = fakeBrowser(() => ({}));
    await openPage(f.browser, "https://loja-exemplo.com.br/p", "mobile");
    expect(f.visited).toEqual(["https://loja-exemplo.com.br/p?html=1"]);
  });

  test("o redirect derrubou o parâmetro: pede de novo a partir da URL final", async () => {
    const f = fakeBrowser(() => ({
      goto: (url) =>
        url.startsWith("https://loja-exemplo.com.br/")
          ? { landsOn: "https://www.loja-exemplo.com.br/p" }
          : {},
    }));
    await openPage(f.browser, "https://loja-exemplo.com.br/p", "mobile");
    expect(f.visited).toEqual([
      "https://loja-exemplo.com.br/p?html=1",
      "https://www.loja-exemplo.com.br/p?html=1",
    ]);
  });

  test("concorrente: abre a URL como veio, sem refazer sem o parâmetro", async () => {
    const f = fakeBrowser(() => ({}));
    const url = "https://concorrente-exemplo.com.br/vestido?_q=vestido&map=ft";
    await openPage(f.browser, url, "mobile", { ownStore: false });
    expect(f.visited).toEqual([url]);
  });

  test("onStatus recebe o status da navegação", async () => {
    const f = fakeBrowser(() => ({ goto: () => ({ status: 404 }) }));
    let seen = 0;
    await openPage(
      f.browser,
      "https://concorrente-exemplo.com.br/x",
      "mobile",
      {
        ownStore: false,
        onStatus: (s) => {
          seen = s;
        },
      },
    );
    expect(seen).toBe(404);
  });
});

describe("openPage: o que não abre", () => {
  test("DNS: PageOpenError com o código do navegador", async () => {
    const f = fakeBrowser(() => ({
      goto: () => ({
        error:
          "net::ERR_NAME_NOT_RESOLVED at https://concorrente-exemplo.com.br/",
        landsOn: "chrome-error://chromewebdata/",
      }),
    }));
    const err = await openPage(
      f.browser,
      "https://concorrente-exemplo.com.br/",
      "mobile",
      { ownStore: false },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PageOpenError);
    expect(String(err)).toContain("net::ERR_NAME_NOT_RESOLVED");
  });

  test("versão pra agente: não é HTML", async () => {
    const f = fakeBrowser(() => ({
      fallback: (fn) =>
        String(fn).includes("contentType") ? "text/markdown" : undefined,
    }));
    await expect(
      openPage(f.browser, "https://loja-exemplo.com.br/p", "mobile"),
    ).rejects.toThrow("text/markdown");
  });

  test("muro por status: BotWallError que é de fora", async () => {
    const f = fakeBrowser(() => ({
      goto: () => ({ status: 403 }),
      scripts: new Map([
        [wallSnapshotInPage, () => ({ links: 0, html: "", text: "" })],
      ]),
    }));
    const err = await openPage(
      f.browser,
      "https://concorrente-exemplo.com.br/",
      "mobile",
      { ownStore: false },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BotWallError);
    expect(isStatusBotWall(err)).toBe(true);
  });
});

describe("navigationFailure (DNS e host fora do ar não são versão pra agente)", () => {
  test("chrome-error page", () => {
    const msg = navigationFailure(
      "chrome-error://chromewebdata/",
      "https://loja.example/",
      "net::ERR_NAME_NOT_RESOLVED at https://loja.example/",
    );
    expect(msg).toContain("não abriu https://loja.example/");
    expect(msg).toContain("net::ERR_NAME_NOT_RESOLVED");
  });

  test("networkidle timeout on a real page", () => {
    expect(
      navigationFailure(
        "https://loja.example/",
        "https://loja.example/",
        "a rede não acalmou em 45000 ms",
      ),
    ).toBeNull();
  });

  test("net::ERR_ABORTED but landed on a real page", () => {
    expect(
      navigationFailure(
        "https://loja.example/",
        "https://loja.example/",
        "net::ERR_ABORTED at https://loja.example/",
      ),
    ).toBeNull();
  });

  test("about:blank with no error", () => {
    expect(
      navigationFailure("about:blank", "https://loja.example/", null),
    ).toBe("não abriu https://loja.example/: página de erro do navegador");
  });
});

describe("isStatusBotWall", () => {
  test("só o muro por status 401/403/429 é de fora", () => {
    const url = "https://concorrente.example/";
    expect(isStatusBotWall(new BotWallError("HTTP 403", url))).toBe(true);
    expect(isStatusBotWall(new BotWallError("HTTP 429", url))).toBe(true);
    expect(isStatusBotWall(new BotWallError("HTTP 500", url))).toBe(false);
    expect(isStatusBotWall(new BotWallError("Cloudflare", url))).toBe(false);
    expect(isStatusBotWall(new Error("HTTP 403"))).toBe(false);
  });
});

describe("withBrowser", () => {
  test("fecha o que ficou aberto e não abre mais nada depois", async () => {
    const closed: number[] = [];
    let n = 0;
    const inner = fakeBrowser(() => ({}));
    const browser: BrowserPort = {
      ...inner.browser,
      async newPage(device, opts) {
        const page = await inner.browser.newPage(device, opts);
        const id = n++;
        return {
          ...page,
          close: async () => {
            closed.push(id);
          },
        };
      },
    };
    const seen: { browser?: BrowserPort } = {};
    await withBrowser(browser, async (b) => {
      seen.browser = b;
      await b.newPage("mobile");
      const second = await b.newPage("desktop");
      await second.close();
    });
    expect(closed.sort()).toEqual([0, 1]);
    if (!seen.browser) throw new Error("withBrowser did not run");
    await expect(seen.browser.newPage("mobile")).rejects.toBeInstanceOf(
      BrowserSessionError,
    );
  });
});

describe("browserFetcher", () => {
  test("a resposta do host vira Response, com a URL final e o user-agent pedido", async () => {
    const asked: Array<{ url: string; userAgent: string; maxBytes: number }> =
      [];
    const f = fakeBrowser(
      () => ({}),
      async (url, opts) => {
        asked.push({ url, userAgent: opts.userAgent, maxBytes: opts.maxBytes });
        return {
          status: 200,
          url: "https://www.loja-exemplo.com.br/robots.txt",
          body: "Sitemap: x",
        };
      },
    );
    const fetcher = browserFetcher(f.browser, {
      maxBytes: 10,
      timeoutMs: 1_000,
    });
    const res = await fetcher("https://loja-exemplo.com.br/robots.txt", {
      headers: { "user-agent": "agente" },
    });
    expect(res.status).toBe(200);
    expect(res.url).toBe("https://www.loja-exemplo.com.br/robots.txt");
    expect(await res.text()).toBe("Sitemap: x");
    expect(asked).toEqual([
      {
        url: "https://loja-exemplo.com.br/robots.txt",
        userAgent: "agente",
        maxBytes: 10,
      },
    ]);
  });

  test("204 sem corpo não quebra", async () => {
    const f = fakeBrowser(
      () => ({}),
      async (url) => ({ status: 204, url, body: "" }),
    );
    const res = await browserFetcher(f.browser, {
      maxBytes: 0,
      timeoutMs: 1_000,
    })("https://loja-exemplo.com.br/");
    expect(res.status).toBe(204);
  });
});
