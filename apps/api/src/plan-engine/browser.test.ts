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

describe("htmlRetryUrl", () => {
  test("an apex redirect dropped ?html=1: asks again with it", () => {
    expect(htmlRetryUrl("https://www.loja-exemplo.com.br/vestido-1/p")).toBe(
      "https://www.loja-exemplo.com.br/vestido-1/p?html=1",
    );
  });

  test("landed on the agent route: drops the .md", () => {
    expect(htmlRetryUrl("https://www.loja-exemplo.com.br/vestido-1/p.md")).toBe(
      "https://www.loja-exemplo.com.br/vestido-1/p?html=1",
    );
  });

  test("the parameter survived, or the page is not http: nothing to redo", () => {
    expect(
      htmlRetryUrl(forceHtml("https://www.loja-exemplo.com.br/x/p")),
    ).toBeNull();
    expect(htmlRetryUrl("about:blank")).toBeNull();
    expect(htmlRetryUrl("chrome-error://chromewebdata/")).toBeNull();
  });
});

describe("fullPageScale", () => {
  test("a full mobile page at 2x fits under the model's 8,000px cap", () => {
    const dsf = VIEWPORTS.mobile.deviceScaleFactor;
    const scale = fullPageScale(FULL_PAGE_MAX_HEIGHT, dsf);
    expect(FULL_PAGE_MAX_HEIGHT * dsf * scale).toBeLessThanOrEqual(
      MAX_IMAGE_SIDE_PX,
    );
    expect(FULL_PAGE_MAX_HEIGHT * dsf * scale).toBeLessThan(8_000);
  });

  test("a short page or desktop at 1x is not shrunk", () => {
    expect(fullPageScale(2_121, 2)).toBe(1);
    expect(
      fullPageScale(FULL_PAGE_MAX_HEIGHT, VIEWPORTS.desktop.deviceScaleFactor),
    ).toBe(1);
  });
});

describe("classifyBotWall", () => {
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

  test("recognizes the known anti-bot walls", () => {
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

  test("a real store with an anti-bot script loaded is not a wall", () => {
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

describe("openPage with tracking blocked", () => {
  test("opens the page with the requested block", async () => {
    const f = fakeBrowser(() => ({}));
    const block = (u: string) => u.includes("tracker");
    await openPage(f.browser, "https://loja-exemplo.com.br/p", "mobile", {
      blockRequest: block,
    });
    expect(f.blockers).toEqual([block]);
  });

  test("without a block, opens the page with none", async () => {
    const f = fakeBrowser(() => ({}));
    await openPage(f.browser, "https://loja-exemplo.com.br/p", "mobile");
    expect(f.blockers).toEqual([undefined]);
  });
});

describe("openPage: ?html=1 only on the analysed store", () => {
  test("asks the analysed store for ?html=1", async () => {
    const f = fakeBrowser(() => ({}));
    await openPage(f.browser, "https://loja-exemplo.com.br/p", "mobile");
    expect(f.visited).toEqual(["https://loja-exemplo.com.br/p?html=1"]);
  });

  test("when a redirect drops the parameter, asks again from the final URL", async () => {
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

  test("opens a competitor URL as given, without retrying for the parameter", async () => {
    const f = fakeBrowser(() => ({}));
    const url = "https://concorrente-exemplo.com.br/vestido?_q=vestido&map=ft";
    await openPage(f.browser, url, "mobile", { ownStore: false });
    expect(f.visited).toEqual([url]);
  });

  test("onStatus receives the navigation status", async () => {
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

describe("openPage: what does not open", () => {
  test("DNS failure: PageOpenError with the browser's code", async () => {
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

  test("an agent version is not HTML", async () => {
    const f = fakeBrowser(() => ({
      fallback: (fn) =>
        String(fn).includes("contentType") ? "text/markdown" : undefined,
    }));
    await expect(
      openPage(f.browser, "https://loja-exemplo.com.br/p", "mobile"),
    ).rejects.toThrow("text/markdown");
  });

  test("a status wall is an external BotWallError", async () => {
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

describe("navigationFailure (DNS and a down host are not an agent version)", () => {
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
  test("only a 401/403/429 status wall is external", () => {
    const url = "https://concorrente.example/";
    expect(isStatusBotWall(new BotWallError("HTTP 403", url))).toBe(true);
    expect(isStatusBotWall(new BotWallError("HTTP 429", url))).toBe(true);
    expect(isStatusBotWall(new BotWallError("HTTP 500", url))).toBe(false);
    expect(isStatusBotWall(new BotWallError("Cloudflare", url))).toBe(false);
    expect(isStatusBotWall(new Error("HTTP 403"))).toBe(false);
  });
});

describe("withBrowser", () => {
  test("closes what was left open and opens nothing afterwards", async () => {
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
  test("the host's answer becomes a Response with the final URL and requested user agent", async () => {
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

  test("a 204 without a body does not break", async () => {
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
