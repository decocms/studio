import { describe, expect, it } from "bun:test";
import {
  appBlockId,
  appResolveType,
  buildAppCatalog,
  parseAppResolveType,
  type DecoStoreApp,
} from "./app-catalog";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";

describe("app-catalog", () => {
  const meta: LiveMeta = {
    manifest: {
      blocks: {
        apps: {
          "site/apps/site.ts": { $ref: "#/definitions/SiteApp" },
          "deco/apps/blog.ts": { $ref: "#/definitions/BlogApp" },
          "commerce/apps/vtex.ts": { $ref: "#/definitions/VtexApp" },
        },
      },
    },
    schema: {
      definitions: {
        BlogApp: {
          title: "Blog",
          description: "Blog app",
        },
      },
    },
  };

  const storeApps: DecoStoreApp[] = [
    {
      name: "vtex",
      title: "VTEX",
      description: "Ecommerce",
      logo: "https://example.com/vtex.png",
      category: "Ecommerce",
      vendor: { alias: "deco", url: "https://apps.deco.cx" },
    },
  ];

  it("buildAppCatalog merges store apps, manifest apps, and installed blocks", () => {
    const decofile = {
      site: { __resolveType: "site/apps/site.ts" },
      "deco-vtex": { __resolveType: "site/apps/deco/vtex.ts" },
      blog: { __resolveType: "site/apps/deco/blog.ts", name: "My Blog" },
    };

    const catalog = buildAppCatalog(storeApps, meta, decofile);

    expect(catalog.find((entry) => entry.id === "deco-vtex")).toEqual({
      id: "deco-vtex",
      app: "vtex",
      vendor: "deco",
      title: "VTEX",
      description: "Ecommerce",
      category: "Ecommerce",
      logo: "https://example.com/vtex.png",
      resolveType: "site/apps/deco/vtex.ts",
      blockKey: "deco-vtex",
      installed: true,
    });

    expect(catalog.find((entry) => entry.id === "deco-blog")).toMatchObject({
      app: "blog",
      vendor: "deco",
      title: "Blog",
      installed: true,
      blockKey: "blog",
    });

    expect(
      catalog.some((entry) => entry.resolveType === "site/apps/site.ts"),
    ).toBe(false);
  });

  it("lists store apps even when not installed", () => {
    const catalog = buildAppCatalog(storeApps, meta, {});

    expect(catalog.find((entry) => entry.id === "deco-vtex")).toMatchObject({
      installed: false,
      blockKey: null,
    });
  });

  it("sorts installed apps before available ones, then alphabetically", () => {
    const decofile = {
      "deco-vtex": { __resolveType: "site/apps/deco/vtex.ts" },
    };
    const catalog = buildAppCatalog(
      [
        {
          name: "analytics",
          title: "Analytics",
          description: "",
          logo: "",
          category: "Analytics",
          vendor: { alias: "deco", url: "https://apps.deco.cx" },
        },
        {
          name: "blog",
          title: "Blog",
          description: "",
          logo: "",
          category: "Tool",
          vendor: { alias: "deco", url: "https://apps.deco.cx" },
        },
        {
          name: "vtex",
          title: "VTEX",
          description: "Ecommerce",
          logo: "",
          category: "Ecommerce",
          vendor: { alias: "deco", url: "https://apps.deco.cx" },
        },
      ],
      { manifest: { blocks: { apps: {} } }, schema: {} },
      decofile,
    );

    expect(catalog.map((entry) => entry.id)).toEqual([
      "deco-vtex",
      "deco-analytics",
      "deco-blog",
    ]);
  });

  it("appBlockId and appResolveType follow admin conventions", () => {
    expect(appBlockId("deco", "vtex")).toBe("deco-vtex");
    expect(appResolveType("deco", "vtex")).toBe("site/apps/deco/vtex.ts");
    expect(parseAppResolveType("commerce/apps/vtex.ts")).toEqual({
      vendor: "commerce",
      app: "vtex",
    });
    expect(parseAppResolveType("site/apps/deco/vtex.ts")).toEqual({
      vendor: "deco",
      app: "vtex",
    });
  });

  it("lists installed custom/local apps without manifest or store entries", () => {
    const emptyMeta: LiveMeta = {
      manifest: { blocks: { apps: {} } },
      schema: {},
    };
    const decofile = {
      "app-tags": {
        __resolveType: "site/apps/local/app-tags.ts",
        account: "lojabagaggio",
      },
    };

    const catalog = buildAppCatalog([], emptyMeta, decofile);

    expect(catalog).toEqual([
      {
        id: "local-app-tags",
        app: "app-tags",
        vendor: "local",
        title: "App Tags",
        description: "",
        category: "Custom",
        resolveType: "site/apps/local/app-tags.ts",
        blockKey: "app-tags",
        installed: true,
      },
    ]);
  });
});
