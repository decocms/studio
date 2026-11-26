import { describe, expect, test } from "bun:test";
import {
  parseSitemap,
  pickChildSitemaps,
  pickPageUrls,
  sitemapCandidates,
  sitemapsFromRobots,
} from "./sitemap.ts";

const ORIGIN = "https://loja-exemplo.com.br";
const HOST = "loja-exemplo.com.br";

const urlset = (paths: string[]) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths
    .map((p) => `<url><loc>${ORIGIN}${p}</loc></url>`)
    .join("")}</urlset>`;

const index = (children: string[]) =>
  `<sitemapindex>${children
    .map((c) => `<sitemap><loc>${ORIGIN}${c}</loc></sitemap>`)
    .join("")}</sitemapindex>`;

/** Fake fetch that counts requests. */
function fakeFetch(files: Record<string, string>) {
  const asked: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    const body = files[url];
    return body === undefined
      ? new Response("", { status: 404 })
      : new Response(body, { status: 200 });
  }) as typeof fetch;
  return { fetcher, asked };
}

describe("sitemapsFromRobots", () => {
  test("the Sitemap: lines, without repeats, any case", () => {
    expect(
      sitemapsFromRobots(
        `User-agent: *\nDisallow: /checkout\nSitemap: ${ORIGIN}/sitemap.xml\r\nsitemap:${ORIGIN}/sitemap-2.xml\nSitemap: ${ORIGIN}/sitemap.xml\n`,
      ),
    ).toEqual([`${ORIGIN}/sitemap.xml`, `${ORIGIN}/sitemap-2.xml`]);
    expect(sitemapsFromRobots("User-agent: *\nDisallow:")).toEqual([]);
  });
});

describe("parseSitemap", () => {
  test("urlset with CDATA and &amp;", () => {
    const xml = `<urlset><url><loc><![CDATA[ ${ORIGIN}/a/p ]]></loc></url><url><loc>${ORIGIN}/b?x=1&amp;y=2</loc></url></urlset>`;
    expect(parseSitemap(xml)).toEqual({
      index: false,
      locs: [`${ORIGIN}/a/p`, `${ORIGIN}/b?x=1&y=2`],
    });
  });

  test("index", () => {
    expect(parseSitemap(index(["/sitemap/product-0.xml"]))).toEqual({
      index: true,
      locs: [`${ORIGIN}/sitemap/product-0.xml`],
    });
  });

  test("file cut in the middle: keeps the complete <loc>s", () => {
    const xml = urlset(["/a/p", "/b/p"]).slice(0, -40);
    expect(parseSitemap(xml).locs).toEqual([`${ORIGIN}/a/p`]);
  });
});

describe("pickChildSitemaps", () => {
  const children = [
    `${ORIGIN}/sitemap/brand-0.xml`,
    `${ORIGIN}/sitemap/product-0.xml.gz`,
    `${ORIGIN}/sitemap/product-1.xml`,
    `${ORIGIN}/sitemap/category-0.xml`,
    `${ORIGIN}/sitemap/pages.xml`,
  ];

  test("product: the product child first, without .gz and without the category one", () => {
    expect(pickChildSitemaps(children, "pdp", 2)).toEqual([
      { url: `${ORIGIN}/sitemap/product-1.xml`, hinted: true },
      { url: `${ORIGIN}/sitemap/pages.xml`, hinted: false },
    ]);
  });

  test("listing: category and brand", () => {
    expect(pickChildSitemaps(children, "listing", 2)).toEqual([
      { url: `${ORIGIN}/sitemap/brand-0.xml`, hinted: true },
      { url: `${ORIGIN}/sitemap/category-0.xml`, hinted: true },
    ]);
  });
});

describe("pickPageUrls", () => {
  const locs = [
    `${ORIGIN}/`,
    `${ORIGIN}/institucional/sobre`,
    `${ORIGIN}/vestidos`,
    `${ORIGIN}/vestido-midi/p`,
    "https://cdn-exemplo.com.br/vestido/p",
    `${ORIGIN}/camisa-linho`,
  ];

  test("product: only store URLs that look like a PDP", () => {
    expect(pickPageUrls(locs, HOST, "pdp", false)).toEqual([
      `${ORIGIN}/vestido-midi/p`,
    ]);
  });

  test("a child that says it is product: a loose slug also counts", () => {
    expect(pickPageUrls(locs, HOST, "pdp", true)).toEqual([
      `${ORIGIN}/vestidos`,
      `${ORIGIN}/vestido-midi/p`,
      `${ORIGIN}/camisa-linho`,
    ]);
  });

  test("listing", () => {
    expect(pickPageUrls(locs, HOST, "listing", true)).toEqual([
      `${ORIGIN}/vestidos`,
      `${ORIGIN}/camisa-linho`,
    ]);
  });

  test("cap of 6", () => {
    const many = Array.from({ length: 50 }, (_, i) => `${ORIGIN}/item-${i}/p`);
    expect(pickPageUrls(many, HOST, "pdp", false).length).toBe(6);
  });
});

describe("sitemapCandidates", () => {
  test("robots -> index -> product child", async () => {
    const { fetcher, asked } = fakeFetch({
      [`${ORIGIN}/robots.txt`]: `Sitemap: ${ORIGIN}/sitemap.xml`,
      [`${ORIGIN}/sitemap.xml`]: index([
        "/sitemap/category-0.xml",
        "/sitemap/product-0.xml",
      ]),
      [`${ORIGIN}/sitemap/product-0.xml`]: urlset([
        "/camisa-linho",
        "/saia-midi",
      ]),
    });
    expect(await sitemapCandidates(ORIGIN, "pdp", fetcher)).toEqual([
      `${ORIGIN}/camisa-linho`,
      `${ORIGIN}/saia-midi`,
    ]);
    // The category one is no use for a PDP: it is not even requested.
    expect(asked).toEqual([
      `${ORIGIN}/robots.txt`,
      `${ORIGIN}/sitemap.xml`,
      `${ORIGIN}/sitemap/product-0.xml`,
    ]);
  });

  test("robots points to another host: uses the store's /sitemap.xml", async () => {
    const { fetcher, asked } = fakeFetch({
      [`${ORIGIN}/robots.txt`]:
        "Sitemap: https://clube.outro-exemplo.com.br/sitemap.xml",
      [`${ORIGIN}/sitemap.xml`]: urlset(["/vestidos", "/vestido-midi/p"]),
    });
    expect(await sitemapCandidates(ORIGIN, "pdp", fetcher)).toEqual([
      `${ORIGIN}/vestido-midi/p`,
    ]);
    expect(asked).not.toContain(
      "https://clube.outro-exemplo.com.br/sitemap.xml",
    );
  });

  test("no robots: /sitemap.xml", async () => {
    const { fetcher } = fakeFetch({
      [`${ORIGIN}/sitemap.xml`]: urlset(["/vestidos", "/vestido-midi/p"]),
    });
    expect(await sitemapCandidates(ORIGIN, "listing", fetcher)).toEqual([
      `${ORIGIN}/vestidos`,
    ]);
  });

  test("large index: at most 5 requests", async () => {
    const files: Record<string, string> = {
      [`${ORIGIN}/robots.txt`]: [1, 2, 3]
        .map((i) => `Sitemap: ${ORIGIN}/s${i}.xml`)
        .join("\n"),
    };
    for (const i of [1, 2, 3])
      files[`${ORIGIN}/s${i}.xml`] = index([
        `/s${i}-a.xml`,
        `/s${i}-b.xml`,
        `/s${i}-c.xml`,
      ]);
    const { fetcher, asked } = fakeFetch(files);
    expect(await sitemapCandidates(ORIGIN, "pdp", fetcher)).toEqual([]);
    expect(asked.length).toBe(5);
  });

  test("network down: empty list, no throw", async () => {
    const fetcher = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await sitemapCandidates(ORIGIN, "pdp", fetcher)).toEqual([]);
  });

  test("cuts the body at the cap, without reading the rest", async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode(
      `<url><loc>${ORIGIN}/vestido-midi/p</loc></url>`.padEnd(100_000, " "),
    );
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 100) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const fetcher = (async (input: RequestInfo | URL) =>
      String(input).endsWith("/sitemap.xml")
        ? new Response(body, { status: 200 })
        : new Response("", { status: 404 })) as typeof fetch;
    expect(await sitemapCandidates(ORIGIN, "pdp", fetcher)).toEqual([
      `${ORIGIN}/vestido-midi/p`,
    ]);
    expect(pulled).toBeLessThan(30);
  });
});
