import { describe, expect, it } from "bun:test";
import {
  extractApps,
  extractGlobalSections,
  extractPages,
  findPageForPath,
  findSiteAppEntry,
  hasEditableDecoContent,
  resolveDeepLinkPage,
  type PageEntry,
} from "./page-list";
import type { LiveMeta } from "./resolve-schema";

describe("page-list", () => {
  it("extractPages finds page blocks with paths", () => {
    const decofile = {
      "pages-home-abc123456789": {
        __resolveType: "website/pages/Page.tsx",
        name: "Home",
        path: "/",
      },
      Header: {
        __resolveType: "site/sections/Header.tsx",
      },
    };

    expect(extractPages(decofile)).toEqual([
      { key: "pages-home-abc123456789", name: "Home", path: "/" },
    ]);
  });

  it("findPageForPath prefers an explicit block key when paths collide", () => {
    const pages = [
      {
        key: "pages-Home Page-11111111-1111-4111-8111-111111111111",
        name: "Home",
        path: "/",
      },
      {
        key: "pages-Home Page-22222222-2222-4222-8222-222222222222",
        name: "Home copy",
        path: "/",
      },
    ];
    expect(findPageForPath(pages, "/", pages[1]!.key)?.key).toBe(pages[1]!.key);
    expect(findPageForPath(pages, "/")?.key).toBe(pages[0]!.key);
  });

  it("findPageForPath returns preferred key even when path no longer matches", () => {
    const pages = [
      {
        key: "pages-home-old",
        name: "Home",
        path: "/old",
      },
      {
        key: "pages-home-new",
        name: "Home",
        path: "/",
      },
    ];
    expect(findPageForPath(pages, "/", "pages-home-old")?.key).toBe(
      "pages-home-old",
    );
  });

  it("extractApps finds installed app blocks", () => {
    const meta: LiveMeta = {
      manifest: {
        blocks: {
          apps: {
            "site/apps/site.ts": { $ref: "#/definitions/SiteApp" },
            "commerce/apps/vtex.ts": { $ref: "#/definitions/VtexApp" },
          },
          sections: {
            "site/sections/Header.tsx": { $ref: "#/definitions/Header" },
          },
        },
      },
      schema: {
        definitions: {
          SiteApp: { title: "Site settings" },
        },
      },
    };
    const decofile = {
      site: {
        __resolveType: "site/apps/site.ts",
        siteName: "My Store",
      },
      vtex: {
        __resolveType: "commerce/apps/vtex.ts",
        account: "myaccount",
      },
      Header: {
        __resolveType: "site/sections/Header.tsx",
        name: "Header",
      },
    };

    expect(extractApps(decofile, meta)).toEqual([
      {
        key: "vtex",
        name: "Vtex",
        resolveType: "commerce/apps/vtex.ts",
      },
    ]);
  });

  it("findSiteAppEntry resolves the canonical site app block", () => {
    const meta: LiveMeta = {
      manifest: {
        blocks: {
          apps: {
            "site/apps/site.ts": { $ref: "#/definitions/SiteApp" },
          },
        },
      },
      schema: {
        definitions: {
          SiteApp: { title: "Site settings" },
        },
      },
    };
    const decofile = {
      site: {
        __resolveType: "site/apps/site.ts",
        siteName: "My Store",
        seo: { title: "Home" },
      },
    };

    expect(findSiteAppEntry(decofile, meta)).toEqual({
      key: "site",
      name: "Site settings",
      resolveType: "site/apps/site.ts",
    });
  });

  it("findSiteAppEntry resolves legacy manifest keys for the site app", () => {
    const meta: LiveMeta = {
      manifest: {
        blocks: {
          apps: {
            "deco/apps/site.ts": { $ref: "#/definitions/SiteApp" },
          },
        },
      },
      schema: {
        definitions: {
          SiteApp: { title: "Site settings" },
        },
      },
    };
    const decofile = {
      site: {
        __resolveType: "site/apps/deco/site.ts",
        siteName: "My Store",
      },
    };

    expect(findSiteAppEntry(decofile, meta)).toEqual({
      key: "site",
      name: "Site settings",
      resolveType: "site/apps/deco/site.ts",
    });
  });

  it("extractGlobalSections uses catalog filters for saved blocks", () => {
    const meta: LiveMeta = {
      manifest: {
        blocks: {
          sections: {
            "site/sections/Header.tsx": { $ref: "#/definitions/Header" },
            "site/sections/Theme/Theme.tsx": { $ref: "#/definitions/Theme" },
          },
        },
      },
      schema: {},
    };
    const decofile = {
      Header: {
        __resolveType: "site/sections/Header.tsx",
        name: "Site Header",
      },
      "Preview Hero": {
        __resolveType: "site/sections/Hero.tsx",
      },
      "pages-about-abc123456789": {
        __resolveType: "website/pages/Page.tsx",
        path: "/about",
      },
    };

    const sections = extractGlobalSections(decofile, meta);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toEqual({
      key: "Header",
      name: "Site Header",
      resolveType: "site/sections/Header.tsx",
    });
  });

  it("hasEditableDecoContent is true when pages exist", () => {
    expect(
      hasEditableDecoContent(
        {
          "pages-home-abc123456789": {
            __resolveType: "website/pages/Page.tsx",
            path: "/",
          },
        },
        null,
      ),
    ).toBe(true);
  });

  it("hasEditableDecoContent is true when only global sections exist", () => {
    const meta: LiveMeta = {
      manifest: {
        blocks: {
          sections: {
            "site/sections/Header.tsx": { $ref: "#/definitions/Header" },
          },
        },
      },
      schema: {},
    };
    const decofile = {
      Header: { __resolveType: "site/sections/Header.tsx", name: "Header" },
    };
    expect(hasEditableDecoContent(decofile, meta)).toBe(true);
  });

  it("hasEditableDecoContent is true when only redirects exist", () => {
    const decofile = {
      "redirects-old-abc": {
        __resolveType: "website/loaders/redirect.ts",
        redirect: { from: "/old", to: "/new", type: "permanent" },
      },
    };
    // No meta needed — redirects are detected without the manifest.
    expect(hasEditableDecoContent(decofile, null)).toBe(true);
  });

  it("hasEditableDecoContent is false without pages or sections", () => {
    expect(hasEditableDecoContent({}, null)).toBe(false);
    expect(
      hasEditableDecoContent({ Header: { __resolveType: "site/x" } }, null),
    ).toBe(false);
  });

  it("hasEditableDecoContent is true when only a site app exists", () => {
    const meta: LiveMeta = {
      manifest: {
        blocks: {
          apps: {
            "site/apps/site.ts": { $ref: "#/definitions/SiteApp" },
          },
        },
      },
      schema: {},
    };
    const decofile = {
      site: { __resolveType: "site/apps/site.ts", name: "My Site" },
    };
    expect(hasEditableDecoContent(decofile, meta)).toBe(true);
  });

  it("hasEditableDecoContent is true when only installed apps exist", () => {
    const meta: LiveMeta = {
      manifest: {
        blocks: {
          apps: {
            "deco/apps/blog.ts": { $ref: "#/definitions/BlogApp" },
          },
        },
      },
      schema: {},
    };
    const decofile = {
      blog: { __resolveType: "site/apps/deco/blog.ts", name: "Blog" },
    };
    expect(hasEditableDecoContent(decofile, meta)).toBe(true);
  });

  describe("resolveDeepLinkPage", () => {
    const pages: PageEntry[] = [
      { key: "pages-Home-abc123456789", name: "Home", path: "/" },
      { key: "pages-PDP-def456", name: "PDP", path: "/produto/*" },
      { key: "pages-PLP-ghi789", name: "PLP", path: "/produto/*" },
      { key: "pages-About-jkl012", name: "About", path: "/sobre" },
    ];

    it("matches an exact page id (decofile block key)", () => {
      expect(
        resolveDeepLinkPage(pages, { pageId: "pages-About-jkl012" })?.key,
      ).toBe("pages-About-jkl012");
    });

    it("matches a page id carried as the key's trailing suffix", () => {
      expect(resolveDeepLinkPage(pages, { pageId: "jkl012" })?.key).toBe(
        "pages-About-jkl012",
      );
    });

    it("falls back to the path template when no id matches", () => {
      const match = resolveDeepLinkPage(pages, {
        pageId: "does-not-exist",
        path: "/produto/tenis-x",
        pathTemplate: "/produto/*",
      });
      // Two pages share the template — pick is deterministic (key-sorted).
      expect(match?.key).toBe("pages-PDP-def456");
    });

    it("falls back to the concrete path for static pages", () => {
      expect(resolveDeepLinkPage(pages, { path: "/sobre" })?.key).toBe(
        "pages-About-jkl012",
      );
    });

    it("returns null when nothing fits", () => {
      expect(resolveDeepLinkPage(pages, { path: "/nao-existe" })).toBeNull();
      expect(resolveDeepLinkPage(pages, {})).toBeNull();
    });
  });
});
