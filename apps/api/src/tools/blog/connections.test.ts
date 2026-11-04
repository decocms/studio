import { describe, expect, test } from "bun:test";
import { blogCardRunConnections } from "./connections";

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
