import { describe, expect, it } from "bun:test";
import {
  detectRouterFramework,
  frameworkRouteRoots,
  frameworkRoutesFromFiles,
  routePathFromFile,
} from "./framework-routes";

describe("detectRouterFramework", () => {
  it("detects Next.js from dependencies", () => {
    expect(detectRouterFramework({ dependencies: { next: "16.0.0" } })).toBe(
      "next",
    );
  });

  it("detects TanStack Router and Start, in devDependencies too", () => {
    expect(
      detectRouterFramework({
        dependencies: { "@tanstack/react-start": "1.0.0" },
      }),
    ).toBe("tanstack");
    expect(
      detectRouterFramework({
        devDependencies: { "@tanstack/react-router": "1.0.0" },
      }),
    ).toBe("tanstack");
  });

  it("detects nothing for a plain Vite app or an invalid manifest", () => {
    expect(
      detectRouterFramework({
        dependencies: { react: "19.0.0", "react-router": "7.0.0" },
        devDependencies: { vite: "7.0.0" },
      }),
    ).toBeNull();
    expect(detectRouterFramework(null)).toBeNull();
    expect(detectRouterFramework("next")).toBeNull();
    expect(detectRouterFramework({ dependencies: ["next"] })).toBeNull();
  });
});

describe("frameworkRouteRoots", () => {
  it("lists Next.js's routers at the repo root without a package path", () => {
    expect(frameworkRouteRoots("next", null).map((root) => root.dir)).toEqual([
      "pages",
      "src/pages",
      "app",
      "src/app",
    ]);
  });

  it("prefixes the package path, trimming its slashes", () => {
    expect(
      frameworkRouteRoots("tanstack", "/apps/site/").map((root) => root.dir),
    ).toEqual(["apps/site/src/routes"]);
  });
});

describe("routePathFromFile (Next.js pages router)", () => {
  const route = (file: string) => routePathFromFile("next-pages", file);

  it("maps index and named files to their path", () => {
    expect(route("index.tsx")).toBe("/");
    expect(route("checkout/index.tsx")).toBe("/checkout");
    expect(route("login.tsx")).toBe("/login");
    expect(route("docs/intro.mdx")).toBe("/docs/intro");
  });

  it("skips special files, API routes and error pages", () => {
    expect(route("_app.tsx")).toBeNull();
    expect(route("_document.tsx")).toBeNull();
    expect(route("api/graphql.ts")).toBeNull();
    expect(route("404.tsx")).toBeNull();
    expect(route("500.tsx")).toBeNull();
    expect(route("errors/404.tsx")).toBe("/errors/404");
  });

  it("skips dynamic routes and non-page files", () => {
    expect(route("[...slug].tsx")).toBeNull();
    expect(route("blog/[slug].tsx")).toBeNull();
    expect(route("styles.module.css")).toBeNull();
    expect(route("login.test.tsx")).toBeNull();
    expect(route("README")).toBeNull();
    expect(route("")).toBeNull();
  });
});

describe("routePathFromFile (Next.js app router)", () => {
  const route = (file: string) => routePathFromFile("next-app", file);

  it("maps page files to their folder, without route groups", () => {
    expect(route("page.tsx")).toBe("/");
    expect(route("warranty/page.tsx")).toBe("/warranty");
    expect(route("(shop)/cart/page.tsx")).toBe("/cart");
  });

  it("skips private folders, slots, interceptors and dynamic segments", () => {
    expect(route("_components/page.tsx")).toBeNull();
    expect(route("@modal/login/page.tsx")).toBeNull();
    expect(route("feed/(..)photo/page.tsx")).toBeNull();
    expect(route("[slug]/page.tsx")).toBeNull();
  });

  it("skips files other than page", () => {
    expect(route("layout.tsx")).toBeNull();
    expect(route("api/route.ts")).toBeNull();
    expect(route("page.css")).toBeNull();
  });
});

describe("routePathFromFile (TanStack Router)", () => {
  const route = (file: string) => routePathFromFile("tanstack", file);

  it("maps flat and nested files to their path", () => {
    expect(route("index.tsx")).toBe("/");
    expect(route("pricing.tsx")).toBe("/pricing");
    expect(route("en/index.tsx")).toBe("/en");
    expect(route("en/pricing.tsx")).toBe("/en/pricing");
    expect(route("embed.diagnostic.tsx")).toBe("/embed/diagnostic");
    expect(route("posts/route.tsx")).toBe("/posts");
    expect(route("about.lazy.tsx")).toBe("/about");
  });

  it("keeps the URL of non-nested routes (`name_`)", () => {
    expect(route("investors_.dgf.index.tsx")).toBe("/investors/dgf");
    expect(route("investors_.dgf.pnl.tsx")).toBe("/investors/dgf/pnl");
  });

  it("drops pathless layouts and groups from the URL", () => {
    expect(route("_auth.dashboard.tsx")).toBe("/dashboard");
    expect(route("(marketing)/about.tsx")).toBe("/about");
    expect(route("_auth.tsx")).toBeNull();
  });

  it("unescapes bracketed characters", () => {
    expect(route("sitemap[.]xml.tsx")).toBe("/sitemap.xml");
  });

  it("skips the root, ignored files and dynamic routes", () => {
    expect(route("__root.tsx")).toBeNull();
    expect(route("-components/header.tsx")).toBeNull();
    expect(route("blog/-card.tsx")).toBeNull();
    expect(route("$.tsx")).toBeNull();
    expect(route("site.$url.tsx")).toBeNull();
    expect(route("launch-week_.$slug.tsx")).toBeNull();
    expect(route("card/$company.tsx")).toBeNull();
  });

  it("skips server handlers and non-route files", () => {
    expect(route("deco/meta.ts")).toBeNull();
    expect(route("deco/invoke.$.ts")).toBeNull();
    expect(route("decohouse/churras.html")).toBeNull();
  });
});

describe("frameworkRoutesFromFiles", () => {
  it("merges both Next.js routers, deduplicated, with / first", () => {
    const [, srcPages, , srcApp] = frameworkRouteRoots("next", "apps/shop");
    expect(
      frameworkRoutesFromFiles([
        {
          root: srcPages!,
          files: [
            "apps/shop/src/pages/index.tsx",
            "apps/shop/src/pages/login.tsx",
            "apps/shop/src/pages/_app.tsx",
            "apps/shop/src/pages/[...slug].tsx",
          ],
        },
        {
          root: srcApp!,
          files: [
            "apps/shop/src/app/warranty/page.tsx",
            "apps/shop/src/app/(marketing)/login/page.tsx",
            "apps/shop/src/app/[slug]/page.tsx",
          ],
        },
      ]),
    ).toEqual(["/", "/login", "/warranty"]);
  });

  it("ignores files outside the listed root", () => {
    const [pages] = frameworkRouteRoots("next", null);
    expect(
      frameworkRoutesFromFiles([
        { root: pages!, files: ["pagesx/index.tsx", "src/pages/a.tsx"] },
      ]),
    ).toEqual([]);
  });

  it("returns nothing for a site without router directories", () => {
    expect(
      frameworkRoutesFromFiles(
        frameworkRouteRoots("next", null).map((root) => ({ root, files: [] })),
      ),
    ).toEqual([]);
  });
});
