import { describe, expect, test } from "bun:test";
import { pageRole, seoProseFor, selectSeoEvidence } from "./seo-evidence";

const page = (key: string, path: string) => ({ key, name: key, path });

/** A page block as a decofile really holds one — the resolveType is what makes
 *  it a page, and without it `findSiteSeoEntry` would read it as the site. */
const pageBlock = (path: string, seo: unknown) => ({
  __resolveType: "website/pages/Page.tsx",
  path,
  seo,
});

describe("seoProseFor", () => {
  test("renders only the props that carry voice", () => {
    expect(
      seoProseFor({
        title: "Farm Rio | do rio pro mundo",
        description: "Moda brasileira feita com alegria",
        image: "https://cdn.example.com/og.jpg",
        noIndexing: false,
        themeColor: "#fff",
      }),
    ).toBe(
      "title: Farm Rio | do rio pro mundo\ndescription: Moda brasileira feita com alegria",
    );
  });

  test("reads through the lazy-render wrapper", () => {
    expect(
      seoProseFor({
        __resolveType: "website/sections/Rendering/Lazy.tsx",
        section: { title: "Sobre nós" },
      }),
    ).toBe("title: Sobre nós");
  });

  test("a disabled seo says nothing", () => {
    expect(seoProseFor(null)).toBe("");
    expect(seoProseFor(undefined)).toBe("");
  });

  test("an seo with only an image says nothing", () => {
    expect(seoProseFor({ image: "https://cdn.example.com/og.jpg" })).toBe("");
  });
});

describe("pageRole", () => {
  test("a PDP seo section marks the page as commerce", () => {
    const decofile = {
      "pages/pdp": pageBlock("/produto", {
        __resolveType: "website/sections/Seo/SeoPDPV2.tsx",
      }),
    };
    expect(pageRole(decofile, page("pages/pdp", "/produto"))).toBe("commerce");
  });

  test("a PLP seo section marks the page as commerce", () => {
    const decofile = {
      "pages/plp": pageBlock("/roupas", {
        __resolveType: "website/sections/Seo/SeoPLP.tsx",
      }),
    };
    expect(pageRole(decofile, page("pages/plp", "/roupas"))).toBe("commerce");
  });

  test("a templated path is commerce even with a general seo section", () => {
    const decofile = {
      "pages/any": pageBlock("/*", {
        __resolveType: "website/sections/Seo/SeoV2.tsx",
      }),
    };
    expect(pageRole(decofile, page("pages/any", "/*"))).toBe("commerce");
  });

  test("root is home, and a plain path is institutional", () => {
    const decofile = {
      "pages/home": pageBlock("/", undefined),
      "pages/sobre": pageBlock("/sobre", undefined),
    };
    expect(pageRole(decofile, page("pages/home", "/"))).toBe("home");
    expect(pageRole(decofile, page("pages/sobre", "/sobre"))).toBe(
      "institutional",
    );
  });
});

describe("selectSeoEvidence", () => {
  test("the site default comes first, then home, then institutional", () => {
    const decofile = {
      site: {
        __resolveType: "site/apps/site.ts",
        seo: { title: "Marca", description: "A marca" },
      },
      "pages/sobre": pageBlock("/sobre", { title: "Sobre" }),
      "pages/home": pageBlock("/", { title: "Home" }),
    };

    expect(
      selectSeoEvidence(decofile, [
        page("pages/sobre", "/sobre"),
        page("pages/home", "/"),
      ]).map((entry) => entry.key),
    ).toEqual(["site", "/", "/sobre"]);
  });

  test("keeps at most two commerce pages — the rest are the same template", () => {
    const pages = Array.from({ length: 10 }, (_, i) =>
      page(`pages/p${i}`, `/p${i}/p`),
    );
    const decofile = Object.fromEntries(
      pages.map((p, i) => [
        p.key,
        pageBlock(p.path, {
          __resolveType: "website/sections/Seo/SeoPDPV2.tsx",
          title: `Produto ${i}`,
        }),
      ]),
    );

    expect(selectSeoEvidence(decofile, pages)).toHaveLength(2);
  });

  test("dedupes on content — a templated title repeats verbatim", () => {
    const pages = [page("pages/a", "/a"), page("pages/b", "/b")];
    const decofile = {
      "pages/a": pageBlock("/a", { title: "Compre na Marca" }),
      "pages/b": pageBlock("/b", { title: "Compre na Marca" }),
    };

    expect(selectSeoEvidence(decofile, pages)).toEqual([
      { key: "/a", content: "title: Compre na Marca" },
    ]);
  });

  test("a site with no seo at all yields nothing", () => {
    expect(selectSeoEvidence({}, [])).toEqual([]);
  });

  test("a page whose seo is disabled is skipped, not emitted empty", () => {
    const decofile = { "pages/a": pageBlock("/a", null) };
    expect(selectSeoEvidence(decofile, [page("pages/a", "/a")])).toEqual([]);
  });
});
