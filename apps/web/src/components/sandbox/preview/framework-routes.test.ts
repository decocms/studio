import { describe, expect, it } from "bun:test";
import {
  frameworkRouteRoots,
  frameworkRoutesFromFiles,
  routePathFromFile,
} from "./framework-routes";

describe("frameworkRouteRoots", () => {
  it("looks at the repo root without a package path", () => {
    expect(frameworkRouteRoots(null).map((root) => root.dir)).toEqual([
      "pages",
      "src/pages",
      "app",
      "src/app",
    ]);
  });

  it("prefixes the package path, trimming its slashes", () => {
    expect(
      frameworkRouteRoots("/apps/storefront/").map((root) => root.dir),
    ).toEqual([
      "apps/storefront/pages",
      "apps/storefront/src/pages",
      "apps/storefront/app",
      "apps/storefront/src/app",
    ]);
  });
});

describe("routePathFromFile (pages router)", () => {
  const route = (file: string) => routePathFromFile("pages", file);

  it("maps index files to their folder", () => {
    expect(route("index.tsx")).toBe("/");
    expect(route("checkout/index.tsx")).toBe("/checkout");
  });

  it("maps named files to their path", () => {
    expect(route("login.tsx")).toBe("/login");
    expect(route("pvt/account.jsx")).toBe("/pvt/account");
    expect(route("docs/intro.mdx")).toBe("/docs/intro");
  });

  it("skips special files, API routes and error pages", () => {
    expect(route("_app.tsx")).toBeNull();
    expect(route("_document.tsx")).toBeNull();
    expect(route("api/graphql.ts")).toBeNull();
    expect(route("404.tsx")).toBeNull();
    expect(route("500.tsx")).toBeNull();
  });

  it("keeps a nested page named like an error page", () => {
    expect(route("errors/404.tsx")).toBe("/errors/404");
  });

  it("skips dynamic routes", () => {
    expect(route("[...slug].tsx")).toBeNull();
    expect(route("blog/[slug].tsx")).toBeNull();
    expect(route("[locale]/about.tsx")).toBeNull();
  });

  it("skips files that aren't pages", () => {
    expect(route("styles.module.css")).toBeNull();
    expect(route("login.test.tsx")).toBeNull();
    expect(route("README")).toBeNull();
    expect(route("")).toBeNull();
  });
});

describe("routePathFromFile (app router)", () => {
  const route = (file: string) => routePathFromFile("app", file);

  it("maps page files to their folder", () => {
    expect(route("page.tsx")).toBe("/");
    expect(route("warranty/page.tsx")).toBe("/warranty");
  });

  it("drops route groups from the URL", () => {
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

describe("frameworkRoutesFromFiles", () => {
  it("merges both routers, deduplicated, with / first", () => {
    const [, srcPages, , srcApp] = frameworkRouteRoots("apps/shop");
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
    const [pages] = frameworkRouteRoots(null);
    expect(
      frameworkRoutesFromFiles([
        { root: pages!, files: ["pagesx/index.tsx", "src/pages/a.tsx"] },
      ]),
    ).toEqual([]);
  });

  it("returns nothing for a site without router directories", () => {
    expect(
      frameworkRoutesFromFiles(
        frameworkRouteRoots(null).map((root) => ({ root, files: [] })),
      ),
    ).toEqual([]);
  });
});
