import { describe, expect, test } from "bun:test";
import type { StudioContext } from "../../core/studio-context";
import {
  blogCardRunConnections,
  blogGroundingConnections,
  requireBlogConnections,
} from "./connections";

/** Only what the guard reads: the org's connections. GA4 here signs in with a token. */
function ctxWith(items: Record<string, unknown>[]): StudioContext {
  return {
    storage: { connections: { list: async () => ({ items }) } },
  } as unknown as StudioContext;
}

const VTEX = {
  id: "conn_vtex",
  app_name: "vtex",
  status: "active",
  configuration_state: { accountName: "acme", appKey: "k", appToken: "t" },
};
const GA4 = {
  id: "conn_ga4",
  app_id: "deco/google-analytics",
  status: "active",
  connection_token: "token",
  configuration_state: { propertyId: "123" },
};

describe("requireBlogConnections", () => {
  test("hands back both ids when both are ready", async () => {
    expect(await requireBlogConnections(ctxWith([VTEX, GA4]), "org")).toEqual({
      vtex: "conn_vtex",
      ga4: "conn_ga4",
    });
  });

  test("refuses naming every one that is missing", async () => {
    await expect(requireBlogConnections(ctxWith([]), "org")).rejects.toThrow(
      "blog-connections-missing: vtex, ga4",
    );
  });

  test("a VTEX without its keys is not ready", async () => {
    const keyless = { ...VTEX, configuration_state: { accountName: "acme" } };
    await expect(
      requireBlogConnections(ctxWith([keyless, GA4]), "org"),
    ).rejects.toThrow("blog-connections-missing: vtex");
  });

  test("hands back Search Console when it is ready, and never waits for it", async () => {
    const gsc = {
      id: "conn_gsc",
      app_name: "google-search-console",
      status: "active",
      connection_token: "token",
      configuration_state: { siteUrl: "https://store.example/" },
    };
    expect(
      await requireBlogConnections(ctxWith([VTEX, GA4, gsc]), "org"),
    ).toEqual({ vtex: "conn_vtex", ga4: "conn_ga4", gsc: "conn_gsc" });
    const unpicked = { ...gsc, configuration_state: {} };
    expect(
      await requireBlogConnections(ctxWith([VTEX, GA4, unpicked]), "org"),
    ).toEqual({ vtex: "conn_vtex", ga4: "conn_ga4" });
    await expect(requireBlogConnections(ctxWith([gsc]), "org")).rejects.toThrow(
      "blog-connections-missing: vtex, ga4",
    );
  });

  test("a GA4 with no property chosen is not ready", async () => {
    const unpicked = { ...GA4, configuration_state: {} };
    await expect(
      requireBlogConnections(ctxWith([VTEX, unpicked]), "org"),
    ).rejects.toThrow("blog-connections-missing: ga4");
  });
});

test("grounding reads VTEX through its allowlist and GA4 whole", () => {
  const [vtex, ga4] = blogGroundingConnections({ vtex: "v", ga4: "g" });
  expect(vtex?.id).toBe("v");
  expect(vtex?.allow?.has("VTEX_IS_GET_PRODUCT_SEARCH")).toBe(true);
  expect(vtex?.allow?.has("VTEX_UPDATE_PRICE")).toBe(false);
  expect(ga4).toEqual({ id: "g", label: "ga4" });
});

test("grounding reads Search Console whole when it is given", () => {
  const read = blogGroundingConnections({ vtex: "v", ga4: "g", gsc: "s" });
  expect(read.map((connection) => connection.label)).toEqual([
    "vtex",
    "ga4",
    "gsc",
  ]);
  expect(read[2]).toEqual({ id: "s", label: "gsc" });
});

describe("blogCardRunConnections", () => {
  test("grants every blog connection, VTEX only through its grounding tools", () => {
    const gsc = { id: "conn_gsc", app_name: "google-search-console" };
    const { ids, limits } = blogCardRunConnections([
      VTEX,
      GA4,
      gsc,
      { id: "conn_other", app_name: "github" },
    ]);
    expect(ids).toEqual(["conn_vtex", "conn_ga4", "conn_gsc"]);
    expect(Object.keys(limits)).toEqual(["conn_vtex"]);
    expect(limits.conn_vtex).toContain("VTEX_IS_GET_PRODUCT_SEARCH");
    expect(limits.conn_vtex).not.toContain("VTEX_UPDATE_PRICE");
  });

  test("an organization without them gets nothing", () => {
    expect(blogCardRunConnections([])).toEqual({ ids: [], limits: {} });
  });
});
