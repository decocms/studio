import { describe, expect, it } from "bun:test";
import {
  siteAppRegistry,
  type SiteAppRegistryEntry,
} from "@decocms/shared/site-apps";
import { buildAppCatalog, parseAppResolveType } from "./app-catalog";
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

  const registryApp = (
    app: string,
    overrides?: Partial<SiteAppRegistryEntry>,
  ): SiteAppRegistryEntry => ({
    blockKey: `deco-${app}`,
    vendor: "deco",
    app,
    title: app.toUpperCase(),
    description: "",
    category: "Ecommerce",
    ...overrides,
  });

  const registry: SiteAppRegistryEntry[] = [
    registryApp("vtex", {
      title: "VTEX",
      description: "Ecommerce",
      logo: "https://example.com/vtex.png",
    }),
  ];

  it("buildAppCatalog merges the registry, manifest apps, and installed blocks", () => {
    const decofile = {
      site: { __resolveType: "site/apps/site.ts" },
      "deco-vtex": { __resolveType: "site/apps/deco/vtex.ts" },
      blog: { __resolveType: "site/apps/deco/blog.ts", name: "My Blog" },
    };

    const catalog = buildAppCatalog(registry, meta, decofile);

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
      installable: true,
    });

    expect(catalog.find((entry) => entry.id === "deco-blog")).toMatchObject({
      app: "blog",
      vendor: "deco",
      title: "Blog",
      installed: true,
      blockKey: "blog",
      // Known to the runtime, but with no patch set behind it.
      installable: false,
    });

    expect(
      catalog.some((entry) => entry.resolveType === "site/apps/site.ts"),
    ).toBe(false);
  });

  it("lists registry apps even when not installed", () => {
    const catalog = buildAppCatalog(registry, meta, {});

    expect(catalog.find((entry) => entry.id === "deco-vtex")).toMatchObject({
      installed: false,
      blockKey: null,
      installable: true,
    });
  });

  it("offers nothing installable when the site's stack is unknown", () => {
    const catalog = buildAppCatalog([], meta, {
      "deco-vtex": { __resolveType: "site/apps/deco/vtex.ts" },
    });

    expect(catalog.every((entry) => !entry.installable)).toBe(true);
    expect(catalog.map((entry) => entry.id)).toContain("deco-vtex");
  });

  it("sorts installed apps before available ones, then alphabetically", () => {
    const catalog = buildAppCatalog(
      [
        registryApp("analytics", { title: "Analytics", category: "Analytics" }),
        registryApp("blog", { title: "Blog", category: "Tool" }),
        registryApp("vtex", { title: "VTEX" }),
      ],
      { manifest: { blocks: { apps: {} } }, schema: {} },
      { "deco-vtex": { __resolveType: "site/apps/deco/vtex.ts" } },
    );

    expect(catalog.map((entry) => entry.id)).toEqual([
      "deco-vtex",
      "deco-analytics",
      "deco-blog",
    ]);
  });

  it("parses both the site/apps and the legacy vendor/apps resolveType", () => {
    expect(parseAppResolveType("commerce/apps/vtex.ts")).toEqual({
      vendor: "commerce",
      app: "vtex",
    });
    expect(parseAppResolveType("site/apps/deco/vtex.ts")).toEqual({
      vendor: "deco",
      app: "vtex",
    });
  });

  it("lists installed custom/local apps without manifest or registry entries", () => {
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
        installable: false,
      },
    ]);
  });
});

describe("a TanStack site's manifest", () => {
  /**
   * Shape captured from a live `tanstack-start` site: every app block is
   * titled with its own module path and carries no description, icon or logo.
   */
  const tanstackMeta = {
    manifest: {
      blocks: {
        apps: {
          "site/apps/deco/analytics.ts": {
            $ref: "#/definitions/c2l0ZS9hcHBzL2RlY28vYW5hbHl0aWNzLnRz",
            namespace: "site",
          },
          "site/apps/deco/blog.ts": {
            $ref: "#/definitions/c2l0ZS9hcHBzL2RlY28vYmxvZy50cw==",
            namespace: "site",
          },
          "site/apps/deco/htmx.ts": {
            $ref: "#/definitions/c2l0ZS9hcHBzL2RlY28vaHRteC50cw==",
            namespace: "site",
          },
          "site/apps/deco/vtex.ts": {
            $ref: "#/definitions/c2l0ZS9hcHBzL2RlY28vdnRleC50cw==",
            namespace: "site",
          },
          "site/apps/local/app-tags.ts": {
            $ref: "#/definitions/c2l0ZS9hcHBzL2xvY2FsL2FwcC10YWdzLnRz",
            namespace: "site",
          },
          "site/apps/site.ts": {
            $ref: "#/definitions/c2l0ZS9hcHBzL3NpdGUudHM=",
            namespace: "site",
          },
        },
      },
    },
    schema: {
      definitions: {
        c2l0ZS9hcHBzL2RlY28vYW5hbHl0aWNzLnRz: {
          title: "site/apps/deco/analytics.ts",
          type: "object",
        },
        "c2l0ZS9hcHBzL2RlY28vYmxvZy50cw==": {
          title: "site/apps/deco/blog.ts",
          type: "object",
        },
        "c2l0ZS9hcHBzL2RlY28vaHRteC50cw==": {
          title: "site/apps/deco/htmx.ts",
          type: "object",
        },
        "c2l0ZS9hcHBzL2RlY28vdnRleC50cw==": {
          title: "site/apps/deco/vtex.ts",
          type: "object",
        },
        c2l0ZS9hcHBzL2xvY2FsL2FwcC10YWdzLnRz: {
          title: "site/apps/local/app-tags.ts",
          type: "object",
        },
        "c2l0ZS9hcHBzL3NpdGUudHM=": {
          title: "site/apps/site.ts",
          type: "object",
        },
      },
    },
  } as unknown as LiveMeta;

  const installed = {
    "deco-analytics": { __resolveType: "site/apps/deco/analytics.ts" },
    "deco-vtex": { __resolveType: "site/apps/deco/vtex.ts" },
    "app-tags": { __resolveType: "site/apps/local/app-tags.ts" },
  };

  it("never shows a module path as an app name", () => {
    for (const entry of buildAppCatalog([], tanstackMeta, installed)) {
      expect(entry.title).not.toContain("/");
      expect(entry.title).not.toEndWith(".ts");
    }
  });

  it("names and illustrates an app from the registry of the OTHER stack", () => {
    // A Deno-era app a migrated site still runs: listed, not installable.
    const catalog = buildAppCatalog([], tanstackMeta, installed);
    expect(catalog.find((e) => e.id === "deco-analytics")).toMatchObject({
      title: "Deco Analytics",
      category: "Analytics",
      installed: true,
      installable: false,
    });
    expect(catalog.find((e) => e.id === "deco-analytics")?.logo).toBeTruthy();
  });

  it("falls back to a humanized app name when no registry knows it", () => {
    expect(
      buildAppCatalog([], tanstackMeta, installed).find(
        (e) => e.id === "local-app-tags",
      ),
    ).toMatchObject({ title: "App Tags", category: "Custom" });
  });

  it("lets the stack registry own an app the manifest also reports", () => {
    const catalog = buildAppCatalog(
      siteAppRegistry("tanstack"),
      tanstackMeta,
      installed,
    );
    const vtex = catalog.filter((e) => e.app === "vtex");
    expect(vtex).toHaveLength(1);
    expect(vtex[0]).toMatchObject({
      title: "VTEX",
      installed: true,
      installable: true,
    });
  });

  it("never lists the site app itself", () => {
    expect(
      buildAppCatalog([], tanstackMeta, installed).some((e) =>
        e.resolveType.endsWith("/site.ts"),
      ),
    ).toBe(false);
  });
});
