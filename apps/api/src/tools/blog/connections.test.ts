import { describe, expect, test } from "bun:test";
import type { StudioContext } from "../../core/studio-context";
import { requireBlogConnections } from "./connections";

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

  test("a GA4 with no property chosen is not ready", async () => {
    const unpicked = { ...GA4, configuration_state: {} };
    await expect(
      requireBlogConnections(ctxWith([VTEX, unpicked]), "org"),
    ).rejects.toThrow("blog-connections-missing: ga4");
  });
});
